import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { beginBrowserSignIn } from '../browser-login.mjs';

const key = { id: '123', name: '<script>name</script>', group: 'cc_plus', key: 'sk-private-key-1234' };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function setup(context, overrides = {}, options = {}) {
  const calls = [];
  const controller = new AbortController();
  context.after(() => controller.abort());
  const flow = await beginBrowserSignIn({
    async login(username, password, signal) { calls.push({ username, password, signal }); return { token: 'private-jwt', userId: '123' }; },
    async listKeys() { return [key]; },
    async complete(session, selected) { return { type: 'success', key: selected.key, metadata: { webToken: session.token } }; },
    errorMessage() { return '登录失败，请重试'; },
    ...overrides,
  }, { signal: controller.signal, ...options });
  const response = await fetch(flow.url);
  const content = await response.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(content)[1];
  const headers = { origin: new URL(flow.url).origin, 'content-type': 'application/x-www-form-urlencoded' };
  const submit = (suffix, values = {}, extraHeaders = {}) => fetch(flow.url + suffix, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: new URLSearchParams({ csrf, ...values }) });
  return { flow, calls, controller, content, headers, submit, response };
}

test('password input is masked and local page blocks framing and caching', async context => {
  const { flow, content, response } = await setup(context);
  assert.match(flow.url, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}$/);
  assert.equal(flow.method, 'auto');
  assert.match(content, /name="password" type="password"/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
});

test('cross-origin, wrong CSRF, wrong content type, unknown paths and methods are denied', async context => {
  const { submit, flow, calls } = await setup(context);
  const credentials = { username: 'account', password: 'private' };
  assert.equal((await submit('/login', credentials, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await submit('/login', credentials, { origin: 'null' })).status, 403);
  const missingOrigin = await fetch(flow.url + '/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(credentials) });
  assert.equal(missingOrigin.status, 403);
  assert.equal((await submit('/login', { ...credentials, csrf: 'wrong' })).status, 403);
  assert.equal((await submit('/login', credentials, { 'content-type': 'application/json' })).status, 403);
  assert.equal((await submit('/login', credentials, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await fetch(flow.url + '/unknown')).status, 404);
  assert.equal((await fetch(flow.url, { method: 'DELETE' })).status, 405);
  assert.equal(calls.length, 0);
});

test('key labels are escaped, key material stays out of HTML and selection must be explicit', async context => {
  const { submit, calls } = await setup(context);
  const response = await submit('/login', { username: 'account', password: 'private' });
  const content = await response.text();
  assert.match(content, /&lt;script&gt;name&lt;\/script&gt;/);
  assert.match(content, /…1234/);
  assert.match(content, /value="" disabled selected/);
  assert.equal(content.includes(key.key), false);
  assert.equal(content.includes('private-jwt'), false);
  assert.equal((await submit('/select', { selection: '123' })).status, 400);
  assert.equal(calls.length, 1);
});

test('raw service errors and submitted passwords never reach the page', async context => {
  const { submit } = await setup(context, { login() { throw Error('super-private-password'); } });
  const response = await submit('/login', { username: 'account', password: 'super-private-password' });
  const content = await response.text();
  assert.equal(response.status, 400);
  assert.match(content, /登录失败/);
  assert.equal(content.includes('super-private-password'), false);
});

test('changed or revoked keys cannot be committed after selection', async context => {
  let listings = 0;
  const { submit } = await setup(context, { listKeys() { return ++listings === 1 ? [key] : []; } });
  const content = await (await submit('/login', { username: 'account', password: 'private' })).text();
  const selection = /<option value="([a-f0-9]+)">/.exec(content)[1];
  const response = await submit('/select', { selection });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /已失效或发生变化/);
});

test('oversized forms are rejected before credentials reach the service', async context => {
  const { submit, calls } = await setup(context);
  assert.equal((await submit('/login', { username: 'account', password: 'a'.repeat(17000) })).status, 400);
  assert.equal(calls.length, 0);
});

test('cancel during website login prevents the later Key-list step', { timeout: 5000 }, async context => {
  const started = deferred(), ready = deferred();
  context.after(() => ready.resolve());
  let listings = 0;
  const { submit, controller, flow } = await setup(context, {
    async login() {
      started.resolve();
      await ready.promise; // Deliberately ignore abort to simulate a late response.
      return { token: 'private-jwt', userId: '123' };
    },
    async listKeys() { listings++; return [key]; },
  });
  const pending = submit('/login', { username: 'account', password: 'private' })
    .then(response => response.text()).catch(error => error);
  await started.promise;
  controller.abort();
  assert.equal((await flow.callback()).type, 'failed');
  ready.resolve();
  await pending;
  await setImmediate();
  assert.equal(listings, 0, 'a late login response cannot start a Key-list request');
  await assert.rejects(fetch(flow.url));
});

test('cancel during Key revalidation prevents login completion', { timeout: 5000 }, async context => {
  const started = deferred(), ready = deferred();
  context.after(() => ready.resolve());
  let listings = 0, completions = 0;
  const { submit, controller, flow } = await setup(context, {
    async listKeys() {
      if (++listings === 2) { started.resolve(); await ready.promise; }
      return [key];
    },
    async complete() { completions++; return { type: 'success', key: key.key }; },
  });
  const content = await (await submit('/login', { username: 'account', password: 'private' })).text();
  const selection = /<option value="([a-f0-9]+)">/.exec(content)[1];
  const pending = submit('/select', { selection }).then(response => response.text()).catch(error => error);
  await started.promise;
  controller.abort();
  assert.equal((await flow.callback()).type, 'failed');
  ready.resolve();
  await pending;
  await setImmediate();
  assert.equal(completions, 0, 'a late Key list cannot trigger balance validation or save credentials');
  await assert.rejects(fetch(flow.url));
});

test('cancel and timeout both close the local server without returning credentials', async context => {
  const cancelled = await setup(context);
  const callback = cancelled.flow.callback();
  cancelled.controller.abort();
  const result = await callback;
  assert.equal(result.type, 'failed');
  assert.match(result.error, /取消/);
  await assert.rejects(fetch(cancelled.flow.url));
  const timedOut = await setup(context, {}, { ttlMs: 100 });
  assert.match((await timedOut.flow.callback()).error, /超时/);
  await assert.rejects(fetch(timedOut.flow.url));
});
