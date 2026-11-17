import test from 'node:test';
import assert from 'node:assert/strict';
import { _internal } from '../index.mjs';

const { createPlugin, RESPONSES_API, ANTHROPIC_API, BALANCE_URL } = _internal;
const auth = async () => ({ type: 'api', key: 'sk-test-only' });
const endpoints = [RESPONSES_API + '/responses', ANTHROPIC_API + '/messages'];
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('already canceled model requests skip auth reload and upstream fetch', async () => {
  for (const url of endpoints) {
    let reads = 0, calls = 0;
    const plugin = createPlugin({ fetchImpl: async () => { calls++; return new Response('unexpected'); } });
    const loader = await plugin.auth.loader(async () => { reads++; return auth(); });
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    controller.abort(reason);
    await assert.rejects(loader.fetch(url, { method: 'POST', signal: controller.signal }), error => error === reason);
    assert.equal(reads, 1, 'only loader initialization reads auth');
    assert.equal(calls, 0);
  }
});

test('cancel during auth loading does not start a billed model request', async () => {
  for (const url of endpoints) {
    const started = deferred(), ready = deferred();
    let reads = 0, calls = 0;
    const plugin = createPlugin({ fetchImpl: async () => { calls++; return new Response('unexpected'); } });
    const loader = await plugin.auth.loader(async () => {
      if (++reads > 1) { started.resolve(); await ready.promise; }
      return auth();
    });
    const controller = new AbortController();
    const reason = new Error('canceled during auth');
    const pending = loader.fetch(url, { method: 'POST', signal: controller.signal });
    await started.promise;
    controller.abort(reason);
    ready.resolve();
    await assert.rejects(pending, error => error === reason);
    assert.equal(calls, 0);
  }
});

test('Request overrides retain new body and abort signal without ambient credentials', async () => {
  for (const url of endpoints) {
    let options;
    const plugin = createPlugin({ fetchImpl: async (_url, init) => { options = init; return new Response('ok'); } });
    const loader = await plugin.auth.loader(auth);
    const controller = new AbortController();
    const request = new Request(url, { method: 'POST', body: 'old', credentials: 'include', headers: { cookie: 'private' } });
    await loader.fetch(request, { body: 'new', signal: controller.signal, credentials: 'include' });
    assert.equal(await new Response(options.body).text(), 'new');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.get('cookie'), null);
    assert.equal(options.duplex, 'half');
    const reason = new Error('caller canceled');
    controller.abort(reason);
    assert.equal(options.signal.aborted, true);
    assert.equal(options.signal.reason, reason);
  }
});

test('model network errors and their cause propagate unchanged without retries', async () => {
  for (const url of endpoints) {
    let calls = 0;
    const cause = new Error('connection reset');
    const original = new TypeError('fetch failed', { cause });
    const plugin = createPlugin({ fetchImpl: async () => { calls++; throw original; } });
    const loader = await plugin.auth.loader(auth);
    await assert.rejects(loader.fetch(url, { method: 'POST' }), error => {
      assert.equal(error, original);
      assert.equal(error.cause, cause);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('stream transport does not read ahead or wait for completion', async () => {
  for (const url of endpoints) {
    const chunks = [new Uint8Array([0xe4, 0xbd]), new Uint8Array([0xa0]), new TextEncoder().encode('\n\n')];
    let pulls = 0;
    const upstream = new Response(new ReadableStream({
      pull(controller) {
        if (pulls < chunks.length) controller.enqueue(chunks[pulls++]);
        else controller.close();
      },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
    const plugin = createPlugin({ fetchImpl: async () => upstream });
    const loader = await plugin.auth.loader(auth);
    const result = await loader.fetch(url, { method: 'POST' });
    assert.equal(result, upstream);
    assert.equal(pulls, 0);
    const reader = result.body.getReader();
    for (let i = 0; i < chunks.length; i++) {
      assert.deepEqual(await reader.read(), { value: chunks[i], done: false });
      assert.equal(pulls, i + 1);
    }
    assert.equal((await reader.read()).done, true);
    reader.releaseLock();
  }
});

test('downstream cancellation and upstream disconnects propagate through original streams', async () => {
  for (const url of endpoints) {
    let canceled, controller;
    const responses = [
      new Response(new ReadableStream({ cancel(reason) { canceled = reason; } })),
      new Response(new ReadableStream({ start(value) { controller = value; } })),
    ];
    const plugin = createPlugin({ fetchImpl: async () => responses.shift() });
    const loader = await plugin.auth.loader(auth);
    const reason = new Error('consumer stopped');
    await (await loader.fetch(url, { method: 'POST' })).body.cancel(reason);
    assert.equal(canceled, reason);
    const reader = (await loader.fetch(url, { method: 'POST' })).body.getReader();
    const disconnected = new Error('upstream disconnected');
    controller.error(disconnected);
    await assert.rejects(reader.read(), error => error === disconnected);
    reader.releaseLock();
  }
});

test('metadata and model requests explicitly disable ambient credentials', async () => {
  const calls = [];
  const now = Date.parse('2026-11-17T00:00:00Z');
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'HS256' })}.${encode({ account_type: 'app_admin', account_id: '123', exp: now / 1000 + 3600 })}.fake-signature`;
  const plugin = createPlugin({ now: () => now, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url === BALANCE_URL) return Response.json({ status: 0, data: { quota: 1, used_quota: 2 } });
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'gpt-test' }] });
    return new Response('ok');
  } });
  const result = await plugin.auth.methods[1].authorize({ key: 'sk-test-only', webToken: token });
  assert.equal(result.type, 'success');
  await plugin.provider.models({ models: {} }, { auth: await auth() });
  const loader = await plugin.auth.loader(auth);
  for (const url of endpoints) await loader.fetch(url, { method: 'POST', credentials: 'include' });
  assert.equal(calls.length, 4);
  for (const { init } of calls) assert.equal(init.credentials, 'omit');
});

test('already canceled model-list requests do not contact upstream', async () => {
  let calls = 0;
  const plugin = createPlugin({ fetchImpl: async () => { calls++; return Response.json({ data: [{ id: 'gpt-test' }] }); } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(plugin.provider.models({ models: {} }, { auth: await auth(), signal: controller.signal }));
  assert.equal(calls, 0);
});

test('blank model names fall back to valid own metadata or model ID', async () => {
  const inherited = { 'gpt-inherited': { name: 'must not inherit', limit: { context: 999 } } };
  const previous = Object.assign(Object.create(inherited), {
    'gpt-test': { name: 'Custom', limit: { context: 123, output: 12 } },
    'claude-test': { name: { invalid: true } },
  });
  const plugin = createPlugin({ fetchImpl: async () => Response.json({ data: [
    { id: 'gpt-test', name: ' \t' }, { id: 'claude-test', name: '' },
    { id: 'gpt-inherited' }, { id: 'gpt-named', name: 'Named' }, null,
  ] }) });
  const models = await plugin.provider.models({ models: previous }, { auth: await auth() });
  assert.equal(models['gpt-test'].name, 'Custom');
  assert.equal(models['gpt-test'].limit.context, 123);
  assert.equal(models['claude-test'].name, 'claude-test');
  assert.equal(models['gpt-inherited'].name, 'gpt-inherited');
  assert.equal(models['gpt-inherited'].limit.context, 0);
  assert.equal(models['gpt-named'].name, 'Named');
});
