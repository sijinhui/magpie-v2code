import test from 'node:test';
import assert from 'node:assert/strict';
import { _internal } from '../index.mjs';

const { createPlugin, BALANCE_URL, LOGIN_URL, RESPONSES_API } = _internal;
const START = Date.parse('2026-11-17T12:00:00+08:00');
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (exp, account = '123') => `${encode({ alg: 'HS256' })}.${encode({ account_type: 'app_admin', account_id: account, exp })}.test-signature`;
const fresh = (now = START) => jwt(now / 1000 + 86400);
const stale = (now = START) => jwt(now / 1000 - 10);
const wallet = { quota: 123.45, used_quota: 67.89, statistics_quota: 4.56 };
const saved = { webUsername: 'site-user', webPassword: 'site-secret-password' };
const authOf = (metadata, key = 'sk-test-only') => async () => ({ type: 'api', key, metadata: { webUserId: '123', ...metadata } });
const ok = data => Response.json({ status: 0, info: 'ok', data });

function setup(respond, clock = { now: START }) {
  const calls = [];
  const plugin = createPlugin({ now: () => clock.now, fetchImpl: async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    return respond(url, init, calls);
  } });
  return { plugin, calls, clock, logins: () => calls.filter(c => c.url === LOGIN_URL), balances: () => calls.filter(c => c.url === BALANCE_URL) };
}

const loginOk = (clock, user = 123) => ok({ jwt_token: fresh(clock.now), user_id: user });

test('without saved credentials an expired token never logs in', async () => {
  const clock = { now: START };
  const { plugin, calls } = setup(() => ok(wallet), clock);
  const usage = await plugin.auth.usage(authOf({ webToken: stale() }));
  assert.ok(usage.error);
  assert.equal(usage.signIn, 'kept');
  assert.equal(calls.length, 0);
});

test('expired token with saved credentials logs in once and reuses the renewed session', async () => {
  const clock = { now: START };
  const { plugin, calls, logins, balances } = setup(url => (url === LOGIN_URL ? loginOk(clock) : ok(wallet)), clock);
  const auth = authOf({ webToken: stale(), ...saved });
  const first = await plugin.auth.usage(auth);
  assert.equal(first.balance, '123.45');
  assert.equal(first.error, undefined);
  assert.equal(logins().length, 1);
  assert.deepEqual(logins()[0].body, { username: 'site-user', password: 'site-secret-password' });
  assert.equal(balances().length, 1);
  assert.equal(balances()[0].init.headers.authorization, fresh());
  assert.equal(balances()[0].init.headers['user-id'], '123');
  await plugin.auth.usage(auth);
  assert.equal(logins().length, 1, 'the renewed token is kept in memory');
  assert.equal(calls.length, 3);
});

test('a valid token is used first and a rejected balance logs in once then retries once', async () => {
  for (const reject of [() => new Response('private', { status: 401 }), () => new Response('private', { status: 403 }), () => Response.json({ status: 101, info: 'private' })]) {
    const clock = { now: START };
    let balance = 0;
    const { plugin, calls, logins, balances } = setup(url => {
      if (url === LOGIN_URL) return loginOk(clock);
      return ++balance === 1 ? reject() : ok(wallet);
    }, clock);
    const usage = await plugin.auth.usage(authOf({ webToken: fresh(), ...saved }));
    assert.equal(usage.balance, '123.45');
    assert.deepEqual(calls.map(c => c.url), [BALANCE_URL, LOGIN_URL, BALANCE_URL]);
    assert.equal(logins().length, 1);
    assert.equal(balances().length, 2);
  }
});

test('renewal is attempted only once per read even if the new token is also refused', async () => {
  const clock = { now: START };
  const { plugin, logins, balances } = setup(url => (url === LOGIN_URL ? loginOk(clock) : new Response('private', { status: 401 })), clock);
  const usage = await plugin.auth.usage(authOf({ webToken: fresh(), ...saved }));
  assert.ok(usage.error);
  assert.equal(usage.signIn, 'kept');
  assert.equal(usage.balance, undefined);
  assert.equal(logins().length, 1);
  assert.equal(balances().length, 2);
});

test('a refused login falls back to a clear message and pauses retries for five minutes', async () => {
  const clock = { now: START };
  const { plugin, logins, balances } = setup(url => (url === LOGIN_URL ? Response.json({ status: 101, info: 'captcha site-secret-password' }) : ok(wallet)), clock);
  const auth = authOf({ webToken: stale(), ...saved });
  const first = await plugin.auth.usage(auth);
  assert.match(first.error, /自动重新登录失败/);
  assert.equal(first.signIn, 'kept');
  assert.equal(JSON.stringify(first).includes('site-secret-password'), false);
  assert.equal(JSON.stringify(first).includes('site-user'), false);
  clock.now += 60000;
  await plugin.auth.usage(auth);
  assert.equal(logins().length, 1, 'no repeated login inside the cooldown');
  clock.now += 5 * 60000;
  await plugin.auth.usage(auth);
  assert.equal(logins().length, 2, 'tries again after the cooldown');
  assert.equal(balances().length, 0, 'an expired token never reaches the balance endpoint');
});

test('concurrent reads share one renewal login', async () => {
  const clock = { now: START };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { plugin, logins } = setup(async url => {
    if (url === LOGIN_URL) { await gate; return loginOk(clock); }
    return ok(wallet);
  }, clock);
  const auth = authOf({ webToken: stale(), ...saved });
  const reads = Array.from({ length: 5 }, () => plugin.auth.usage(auth));
  await new Promise(resolve => setTimeout(resolve, 10));
  release();
  const results = await Promise.all(reads);
  assert.equal(logins().length, 1);
  for (const usage of results) assert.equal(usage.balance, '123.45');
});

test('changed saved credentials do not reuse another credential set\'s session', async () => {
  const clock = { now: START };
  const { plugin, logins } = setup(url => (url === LOGIN_URL ? loginOk(clock) : ok(wallet)), clock);
  await plugin.auth.usage(authOf({ webToken: stale(), ...saved }));
  await plugin.auth.usage(authOf({ webToken: stale(), webUsername: 'site-user', webPassword: 'changed-password' }));
  assert.equal(logins().length, 2);
});

test('a login for another website account is rejected and never used for balance', async () => {
  const clock = { now: START };
  const { plugin, balances } = setup(url => (url === LOGIN_URL ? ok({ jwt_token: fresh(clock.now), user_id: 123 }) : ok(wallet)), clock);
  const usage = await plugin.auth.usage(authOf({ webToken: stale(), ...saved, webUserId: '999' }));
  assert.ok(usage.error);
  assert.equal(usage.balance, undefined);
  assert.equal(balances().length, 0);
});

test('saved credentials go only to the website login endpoint, never to balance or models', async () => {
  const clock = { now: START };
  const { plugin, calls } = setup(url => (url === LOGIN_URL ? loginOk(clock) : ok(wallet)), clock);
  await plugin.auth.usage(authOf({ webToken: stale(), ...saved }));
  for (const call of calls) {
    const text = JSON.stringify([call.init.headers, call.url]);
    assert.equal(text.includes('site-secret-password'), false, call.url);
    if (call.url !== LOGIN_URL) assert.equal(String(call.init.body).includes('site-secret-password'), false);
  }
  const requests = [];
  const model = createPlugin({ fetchImpl: async (_url, init) => { requests.push(init); return new Response('ok'); } });
  const loader = await model.auth.loader(authOf({ webToken: fresh(), ...saved }));
  await loader.fetch(RESPONSES_API + '/responses', { method: 'POST', body: '{}' });
  assert.equal(JSON.stringify([...requests[0].headers]).includes('site-secret-password'), false);
  assert.equal(JSON.stringify([...requests[0].headers]).includes('site-user'), false);
});

test('canceled renewal does not start the pause and nothing is requested afterwards', async () => {
  const clock = { now: START };
  const controller = new AbortController();
  const { plugin, logins } = setup((url, init) => {
    if (url === LOGIN_URL) { controller.abort(); throw init.signal.reason; }
    return ok(wallet);
  }, clock);
  const auth = authOf({ webToken: stale(), ...saved });
  const canceled = await plugin.auth.usage(auth, undefined, { signal: controller.signal });
  assert.ok(canceled.error);
  assert.equal(logins().length, 1);
  await plugin.auth.usage(auth);
  assert.equal(logins().length, 2, 'a canceled attempt is not counted as a refused login');
});

test('malformed or oversized saved credentials are ignored', async () => {
  const clock = { now: START };
  const { plugin, calls } = setup(() => ok(wallet), clock);
  for (const bad of [{ webUsername: '', webPassword: 'x' }, { webUsername: 'u', webPassword: '' }, { webUsername: 'u' }, { webUsername: 1, webPassword: 2 }, { webUsername: 'u'.repeat(201), webPassword: 'x' }, { webUsername: 'u', webPassword: 'x'.repeat(4097) }]) {
    assert.ok((await plugin.auth.usage(authOf({ webToken: stale(), ...bad }))).error);
  }
  assert.equal(calls.length, 0);
});
