import test from 'node:test';
import assert from 'node:assert/strict';
import V2codePlugin, { _internal } from '../index.mjs';

const { createPlugin, webSession, usageOf, queryWindow, keysOf, RESPONSES_API, ANTHROPIC_API, BALANCE_URL, LOGIN_URL, KEYS_URL } = _internal;
const NOW = Date.parse('2026-11-13T22:00:00+08:00');
const info = { quota: 123.45, used_quota: 67.89, private_field: 'must-not-escape' };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims = {}, header = { alg: 'HS256', typ: 'JWT' }) => `${encode(header)}.${encode({ account_type: 'app_admin', account_id: '123', exp: NOW / 1000 + 86400, ...claims })}.test-signature`;
const auth = (metadata = { webToken: jwt(), webUserId: '123' }, key = 'sk-test-only') => async () => ({ type: 'api', key, metadata });
const response = data => Response.json({ status: 0, info: 'ok', data });

function setup(respond = () => response(info)) {
  const calls = [];
  const plugin = createPlugin({ now: () => NOW, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return respond(url, init, calls);
  } });
  return { plugin, calls };
}

test('entry exposes original provider and exact protocol-specific endpoints', async () => {
  const plugin = await V2codePlugin();
  const config = {};
  await plugin.config(config);
  assert.equal(plugin.auth.provider, 'v2code');
  assert.equal(plugin.provider.id, 'v2code');
  assert.equal(plugin.auth.methods.length, 3);
  assert.equal(plugin.auth.methods[0].type, 'oauth');
  assert.deepEqual(config.provider.v2code.models['gpt-6-astra'].provider, { npm: '@ai-sdk/openai', api: RESPONSES_API });
  assert.deepEqual(config.provider.v2code.models['claude-opus-5-5'].provider, { npm: '@ai-sdk/anthropic', api: ANTHROPIC_API });
  config.provider.v2code.models['gpt-6-astra'].name = 'custom';
  await plugin.config(config);
  assert.equal(config.provider.v2code.models['gpt-6-astra'].name, 'custom');
  const other = {};
  await plugin.config(other);
  config.provider.v2code.models['gpt-6-astra'].limit.context = 123;
  assert.equal(other.provider.v2code.models['gpt-6-astra'].limit.context, 1050000);
});

test('login derives user id and validates balance before keeping credentials', async () => {
  const { plugin, calls } = setup();
  const result = await plugin.auth.methods[1].authorize({ key: ' sk-test-only ', webToken: jwt() });
  assert.deepEqual(result, { type: 'success', key: 'sk-test-only', metadata: { webToken: jwt(), webUserId: '123' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, BALANCE_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, jwt());
  assert.equal(calls[0].init.headers['user-id'], '123');
  assert.equal(JSON.stringify(calls).includes('sk-test-only'), false);
  assert.equal(JSON.stringify(calls).includes('password'), false);
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.signal.aborted, false);
});

test('refused login never reports success or exposes vendor response', async () => {
  const { plugin, calls } = setup(() => Response.json({ status: 101, info: `secret ${jwt()} sk-test-only` }));
  const result = await plugin.auth.methods[1].authorize({ key: 'sk-test-only', webToken: jwt() });
  assert.equal(result.type, 'failed');
  assert.match(result.error, /认证失效/);
  assert.equal(JSON.stringify(result).includes(jwt()), false);
  assert.equal(JSON.stringify(result).includes('sk-test-only'), false);
  assert.equal(calls.length, 1);
});

test('invalid credentials fail login without network calls', async () => {
  const { plugin, calls } = setup();
  for (const input of [{}, { key: 'sk-valid' }, { key: 'sk-invalid\nheader', webToken: jwt() }, { key: jwt(), webToken: jwt() }, { key: 'sk-valid', webToken: 'sk-not-a-jwt' }]) {
    assert.equal((await plugin.auth.methods[1].authorize(input)).type, 'failed');
  }
  assert.equal(calls.length, 0);
});

test('JWT structural validation rejects wrong accounts, expiry, and mismatched ids', () => {
  assert.deepEqual(webSession(jwt(), '123', NOW), { token: jwt(), userId: '123' });
  for (const token of [jwt({ exp: NOW / 1000 }), jwt({ exp: 'future' }), jwt({ exp: null }), jwt({ exp: 0 }), jwt({ account_id: '' }), jwt({ account_id: '123\n' }), jwt({ account_type: 'model' }), jwt({}, { alg: 'none' }), 'eyJbroken.payload.signature', `Bearer ${jwt()}`, jwt() + '\nheader', 'a'.repeat(9000)]) {
    assert.throws(() => webSession(token, undefined, NOW));
  }
  assert.throws(() => webSession(jwt(), '456', NOW));
  assert.throws(() => webSession('', undefined, NOW));
});

test('wallet reports prepaid balance, not a fictional quota percentage or reset', async () => {
  const { plugin, calls } = setup();
  const usage = await plugin.auth.usage(auth());
  assert.equal(usage.balance, '123.45');
  assert.equal(usage.windows[0].balance, 123.45);
  assert.equal(usage.windows[0].used, undefined);
  assert.equal(usage.windows[0].limit, undefined);
  assert.equal(usage.windows[0].resetsAt, undefined);
  assert.equal(usage.windows[1].amount, 67.89);
  assert.equal(usage.windows[1].aside, true);
  assert.match(usage.windows[1].display, /191\.34/);
  assert.equal(usage.until, undefined);
  assert.equal(usage.signIn, 'kept');
  assert.equal(JSON.stringify(usage).includes('must-not-escape'), false);
  assert.equal(calls.length, 1);
});

test('zero and negative balances remain known values; missing values are not zero', () => {
  assert.equal(usageOf({ quota: 0, used_quota: 0 }).balance, '0.00');
  assert.equal(usageOf({ quota: -1, used_quota: 2 }).windows[0].balance, -1);
  assert.equal(usageOf({ quota: '1.20', used_quota: '2.30' }).balance, '1.20');
  for (const invalid of [null, undefined, '', ' ', 'NaN', 'Infinity', NaN, Infinity, {}, true]) {
    assert.throws(() => usageOf({ quota: invalid, used_quota: 0 }));
    assert.throws(() => usageOf({ quota: 0, used_quota: invalid }));
  }
  assert.throws(() => usageOf({ quota: 1, used_quota: -1 }));
  assert.throws(() => usageOf({ quota: Number.MAX_VALUE, used_quota: Number.MAX_VALUE }));
});

test('query dates always follow Asia/Shanghai, including UTC date rollover', () => {
  const query = queryWindow(Date.parse('2026-11-13T16:00:00Z'));
  assert.deepEqual(query, { start_time: Date.parse('2026-11-14T00:00:00+08:00') / 1000, end_time: Date.parse('2026-11-14T23:59:59+08:00') / 1000, default_time: 'day' });
});

test('missing or expired web session keeps models signed in and makes no balance request', async () => {
  const { plugin, calls } = setup();
  for (const metadata of [{}, { webToken: jwt({ exp: NOW / 1000 - 1 }), webUserId: '123' }, { webToken: jwt(), webUserId: '456' }]) {
    const usage = await plugin.auth.usage(auth(metadata));
    assert.equal(usage.signIn, 'kept');
    assert.ok(usage.error);
    assert.equal(usage.balance, undefined);
    assert.deepEqual(usage.windows, []);
    const loader = await plugin.auth.loader(auth(metadata));
    assert.equal(loader.apiKey, 'sk-test-only');
  }
  assert.equal(calls.length, 0);
});

for (const status of [401, 403, 429, 500]) {
  test(`HTTP ${status} does not retry, erase login, or expose raw content`, async () => {
    const { plugin, calls } = setup(() => new Response('private vendor error', { status }));
    const usage = await plugin.auth.usage(auth());
    assert.ok(usage.error);
    assert.equal(usage.signIn, 'kept');
    assert.equal(usage.balance, undefined);
    assert.equal(JSON.stringify(usage).includes('private'), false);
    assert.equal(calls.length, 1);
  });
}

test('invalid JSON, malformed envelopes and network errors stay sanitized', async () => {
  for (const respond of [() => new Response('<html>verification</html>'), () => Response.json({ status: '0', data: info }), () => response({ quota: 1 }), () => Response.json({ status: 101, info: jwt() }), () => { throw new Error(`private ${jwt()}`); }]) {
    const { plugin } = setup(respond);
    const usage = await plugin.auth.usage(auth());
    assert.ok(usage.error);
    assert.equal(usage.signIn, 'kept');
    assert.equal(JSON.stringify(usage).includes(jwt()), false);
    assert.equal(JSON.stringify(usage).includes('private'), false);
  }
});

test('JSON response is bounded and oversized streams are cancelled', async () => {
  let cancelled = false;
  const { plugin } = setup(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  })));
  assert.match((await plugin.auth.usage(auth())).error, /回复过大/);
  assert.equal(cancelled, true);
});

test('caller cancellation is forwarded to the balance request', async () => {
  const { plugin, calls } = setup();
  const controller = new AbortController();
  await plugin.auth.usage(auth(), {}, { signal: controller.signal });
  controller.abort();
  assert.equal(calls[0].init.signal.aborted, true);
});

test('multiple accounts and changing website tokens are isolated without a session cache', async () => {
  const { plugin, calls } = setup();
  await Promise.all([plugin.auth.usage(auth()), plugin.auth.usage(auth({ webToken: jwt({ account_id: '456' }), webUserId: '456' }, 'sk-second'))]);
  assert.equal(calls[0].init.headers['user-id'], '123');
  assert.equal(calls[1].init.headers['user-id'], '456');
  await plugin.auth.usage(auth({ webToken: jwt({ exp: NOW / 1000 + 100000 }), webUserId: '123' }));
  assert.notEqual(calls[0].init.headers.authorization, calls[2].init.headers.authorization);
  assert.equal(JSON.stringify(calls).includes('sk-second'), false);
});

test('Responses streaming preserves tools, body, signal and response identity', async () => {
  const upstream = new Response('event: response.completed\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  const { plugin, calls } = setup(() => upstream);
  const loader = await plugin.auth.loader(auth());
  const body = JSON.stringify({ model: 'gpt-6-astra', stream: true, tools: [{ type: 'function', name: 'probe', parameters: { type: 'object' } }] });
  const signal = new AbortController().signal;
  const result = await loader.fetch(RESPONSES_API + '/responses', { method: 'POST', body, signal, headers: { authorization: jwt(), cookie: 'private', 'user-id': '123', 'x-access-token': jwt(), 'x-auth-token': jwt(), 'x-magpie-session': 'internal', 'x-test': 'kept' } });
  assert.equal(result, upstream);
  assert.equal(calls[0].init.body, body);
  assert.equal(calls[0].init.signal, signal);
  assert.equal(calls[0].init.headers.get('authorization'), 'Bearer sk-test-only');
  for (const header of ['cookie', 'user-id', 'x-api-key', 'x-access-token', 'x-auth-token', 'x-magpie-session']) {
    assert.equal(calls[0].init.headers.get(header), null);
  }
  assert.equal(calls[0].init.headers.get('x-test'), 'kept');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(JSON.stringify([...calls[0].init.headers]).includes(jwt()), false);
});

test('Messages uses the Japan node and preserves explicit anthropic version', async () => {
  const { plugin, calls } = setup();
  const loader = await plugin.auth.loader(auth());
  await loader.fetch(ANTHROPIC_API + '/messages', { method: 'POST', body: '{}', headers: { 'anthropic-version': '2023-06-01' } });
  await loader.fetch(ANTHROPIC_API + '/messages/count_tokens', { method: 'POST', body: '{}' });
  for (const call of calls) {
    assert.equal(call.init.headers.get('authorization'), 'Bearer sk-test-only');
    assert.equal(call.init.headers.get('x-api-key'), 'sk-test-only');
    assert.equal(call.init.headers.get('anthropic-version'), '2023-06-01');
  }
});

test('Request objects stream through and model key changes take effect immediately', async () => {
  const { plugin, calls } = setup();
  let key = 'sk-first';
  const loader = await plugin.auth.loader(async () => ({ type: 'api', key }));
  await loader.fetch(new Request(RESPONSES_API + '/responses', { method: 'POST', body: '{}' }));
  key = 'sk-second';
  await loader.fetch(RESPONSES_API + '/responses', { method: 'POST', body: '{}' });
  assert.equal(calls[0].init.headers.get('authorization'), 'Bearer sk-first');
  assert.equal(calls[1].init.headers.get('authorization'), 'Bearer sk-second');
  assert.ok(calls[0].init.body instanceof ReadableStream);
  assert.equal(calls[0].init.duplex, 'half');
});

test('unknown destinations, cross-protocol paths, URLs and methods receive no credentials', async () => {
  const { plugin, calls } = setup();
  const loader = await plugin.auth.loader(auth());
  for (const url of ['https://example.com/v1/responses', BALANCE_URL, 'https://jp.v2code.ai/v1/responses', 'https://dev.v2code.ai/v1/messages', RESPONSES_API + '/responses/compact', RESPONSES_API + '/chat/completions', 'http://dev.v2code.ai/v1/responses', 'https://user@dev.v2code.ai/v1/responses', RESPONSES_API + '/responses?redirect=external', RESPONSES_API + '/responses#fragment']) {
    await assert.rejects(loader.fetch(url, { method: 'POST' }));
  }
  await assert.rejects(loader.fetch(RESPONSES_API + '/responses', { method: 'GET' }));
  assert.equal(calls.length, 0);
});

test('website JWT accidentally used as model key is rejected before model requests', async () => {
  const { plugin, calls } = setup();
  await assert.rejects(plugin.auth.loader(auth({}, jwt())), /必须分开/);
  assert.equal(calls.length, 0);
});

test('model listing uses only model key and maps actual supported model families', async () => {
  const { plugin, calls } = setup(() => Response.json({ data: [{ id: 'gpt-6-astra' }, { id: 'claude-opus-5-5' }, { id: 'gpt-new' }, { id: 'gemini-unknown' }, { id: '__proto__' }, { id: 'gpt-../injection' }, null] }));
  const previous = { models: { 'gpt-6-astra': { name: 'custom', limit: { context: 123, output: 12 }, capabilities: { toolcall: true } } } };
  const models = await plugin.provider.models(previous, { auth: await auth()() });
  assert.deepEqual(Object.keys(models), ['gpt-6-astra', 'claude-opus-5-5', 'gpt-new']);
  assert.equal(models['gpt-6-astra'].api.url, RESPONSES_API);
  assert.equal(models['gpt-6-astra'].api.npm, '@ai-sdk/openai');
  assert.equal(models['claude-opus-5-5'].api.url, ANTHROPIC_API);
  assert.equal(models['claude-opus-5-5'].api.npm, '@ai-sdk/anthropic');
  assert.equal(models['gpt-6-astra'].limit.context, 123);
  assert.deepEqual(models['gpt-new'].limit, { context: 0, output: 0 });
  assert.deepEqual(models['gpt-new'].capabilities, {});
  assert.equal(calls[0].url, RESPONSES_API + '/models');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test-only');
  assert.equal(JSON.stringify(calls).includes(jwt()), false);
});

test('unsigned-in listing stays local and malformed model catalogs fail explicitly', async () => {
  const { plugin, calls } = setup();
  const previous = { models: { kept: {} } };
  assert.equal(await plugin.provider.models(previous), previous.models);
  assert.equal(calls.length, 0);
  for (const data of [null, [], [{ id: 'gemini-unknown' }]]) {
    const broken = setup(() => Response.json({ data })).plugin;
    await assert.rejects(broken.provider.models(previous, { auth: await auth()() }));
  }
});

test('key selection excludes disabled, expired, exhausted, masked or malformed keys', () => {
  const row = { id: 1, key: 'abcdefgh123456', name: '工作', group: 'cc_plus', status: 1, expired_time: -1, unlimited_quota: true };
  const rows = [row, { ...row, id: 2, status: 2 }, { ...row, id: 3, expired_time: NOW / 1000 }, { ...row, id: 4, unlimited_quota: false, remain_quota: 0 }, { ...row, id: 5, key: 'masked****' }, { ...row, id: 6, key: jwt() }, { ...row, id: 7, expired_time: null }, { ...row, id: 8, key: 'bad\nheader' }, { ...row, id: 9, key: 'tiny' }, { ...row, id: 10, key: 'sk-prefixed123456', unlimited_quota: false, remain_quota: '500000' }];
  const keys = keysOf(rows, NOW);
  assert.deepEqual(keys.map(key => key.id), ['1', '10']);
  assert.equal(keys[0].key, 'sk-abcdefgh123456');
  assert.equal(keys[1].key, 'sk-prefixed123456');
  assert.throws(() => keysOf([row, row], NOW));
});

test('browser account login reads all pages, revalidates selection and saves only chosen key', async context => {
  const rows = [{ id: 1, key: 'first-secret1111', name: '第一把', group: 'cc_plus', status: 1, expired_time: -1, unlimited_quota: true }, { id: 2, key: 'second-secret2222', name: '第二把', group: 'codex', status: 1, expired_time: -1, unlimited_quota: false, remain_quota: 500000 }];
  const { plugin, calls } = setup((url, init) => {
    if (url === LOGIN_URL) {
      assert.deepEqual(JSON.parse(init.body), { username: 'test-account', password: 'test-password' });
      assert.equal(init.headers.authorization, undefined);
      return response({ jwt_token: jwt(), user_id: 123 });
    }
    if (url === KEYS_URL) {
      assert.equal(init.headers.authorization, jwt());
      assert.equal(init.headers['user-id'], '123');
      const { page, page_size } = JSON.parse(init.body);
      assert.equal(page_size, 100);
      return response({ rows: [rows[page - 1]], total: 2 });
    }
    assert.equal(url, BALANCE_URL);
    return response(info);
  });
  const controller = new AbortController();
  context.after(() => controller.abort());
  const flow = await plugin.auth.methods[0].authorize(undefined, { signal: controller.signal });
  const origin = new URL(flow.url).origin;
  const loginHtml = await (await fetch(flow.url)).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(loginHtml)[1];
  const headers = { origin, 'content-type': 'application/x-www-form-urlencoded' };
  const selectionHtml = await (await fetch(flow.url + '/login', { method: 'POST', headers, body: new URLSearchParams({ csrf, username: 'test-account', password: 'test-password' }) })).text();
  assert.match(selectionHtml, /第一把/);
  assert.match(selectionHtml, /第二把/);
  assert.equal(selectionHtml.includes('first-secret'), false);
  assert.equal(selectionHtml.includes('second-secret'), false);
  assert.equal(selectionHtml.includes(jwt()), false);
  const options = [...selectionHtml.matchAll(/<option value="([a-f0-9]+)">/g)].map(match => match[1]);
  assert.equal(options.length, 2);
  const done = flow.callback();
  const chosenResponse = await fetch(flow.url + '/select', { method: 'POST', headers, body: new URLSearchParams({ csrf, selection: options[1] }) });
  assert.equal(chosenResponse.status, 200);
  assert.match(await chosenResponse.text(), /已完成选择/);
  const result = await done;
  assert.equal(result.type, 'success');
  assert.equal(result.key, 'sk-second-secret2222');
  assert.equal(result.metadata.keyId, '2');
  assert.equal(result.metadata.webToken, jwt());
  assert.equal(JSON.stringify(result).includes('first-secret'), false);
  assert.equal(JSON.stringify(result).includes('test-password'), false);
  assert.equal(JSON.stringify(result).includes('test-account'), false);
  assert.equal(calls.filter(call => call.url === KEYS_URL).length, 4);
  assert.equal(calls.filter(call => call.url === LOGIN_URL).length, 1);
});
