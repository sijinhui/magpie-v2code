import test from 'node:test';
import assert from 'node:assert/strict';
import { _internal } from '../index.mjs';

const { createPlugin, RESPONSES_API } = _internal;
const auth = async () => ({ type: 'api', key: 'sk-test-only' });
const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

const cases = {
  'text deltas including multibyte characters': event('response.output_text.delta', { delta: '你好' }) + event('response.completed', { response: { status: 'completed', output: [] } }),
  'tool-only output': event('response.output_item.done', { item: { type: 'function_call', call_id: 'call_test', name: 'probe', arguments: '{}' } }),
  'genuinely empty completion': event('response.completed', { response: { status: 'completed', output: [], usage: { output_tokens: 4 } } }),
  'text present only in completed output': event('response.completed', { response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }] } }),
  'reasoning-only output': event('response.output_item.done', { item: { type: 'reasoning', summary: [] } }),
  'failed completion': event('response.failed', { response: { status: 'failed', error: { code: 'server_error', message: 'test failure' } } }),
  'incomplete completion': event('response.incomplete', { response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }),
  'truncated event': 'event: response.output_text.delta\ndata: {"delta":"unfinished',
};

// These tests cover the plugin transport, not Magpie's SDK/protocol adapter.
for (const [name, fixture] of Object.entries(cases)) {
  test(`model transport preserves ${name} without buffering or retries`, async () => {
    const bytes = new TextEncoder().encode(fixture);
    let cursor = 0;
    let calls = 0;
    const upstream = new Response(new ReadableStream({
      pull(controller) {
        if (cursor === bytes.length) return controller.close();
        // Split UTF-8 characters and JSON across chunks deliberately.
        controller.enqueue(bytes.slice(cursor, ++cursor));
      },
    }), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'test-request' } });
    const plugin = createPlugin({ fetchImpl: async () => { calls++; return upstream; } });
    const loader = await plugin.auth.loader(auth);
    const result = await loader.fetch(RESPONSES_API + '/responses', { method: 'POST', body: '{}' });
    assert.equal(result, upstream);
    assert.equal(result.bodyUsed, false);
    assert.equal(result.headers.get('x-request-id'), 'test-request');
    assert.deepEqual(new Uint8Array(await result.arrayBuffer()), bytes);
    assert.equal(calls, 1);
  });
}

test('upstream HTTP errors retain status, headers and error body', async () => {
  const body = '{"error":{"message":"upstream unavailable","code":"server_error"}}';
  let calls = 0;
  const upstream = new Response(body, { status: 502, headers: { 'content-type': 'application/json', 'retry-after': '5' } });
  const plugin = createPlugin({ fetchImpl: async () => { calls++; return upstream; } });
  const loader = await plugin.auth.loader(auth);
  const result = await loader.fetch(RESPONSES_API + '/responses', { method: 'POST', body: '{}' });
  assert.equal(result.status, 502);
  assert.equal(result.headers.get('retry-after'), '5');
  assert.equal(await result.text(), body);
  assert.equal(calls, 1);
});

test('model request budget and state are not rewritten; abort is not retried', async () => {
  const controller = new AbortController();
  const body = JSON.stringify({ model: 'gpt-6.1-sol', stream: true, max_output_tokens: 16000, store: false, previous_response_id: 'resp_test', reasoning: { effort: 'medium' } });
  let calls = 0;
  const plugin = createPlugin({ fetchImpl: async (_url, init) => {
    calls++;
    assert.equal(init.body, body);
    assert.equal(init.signal, controller.signal);
    controller.abort();
    throw controller.signal.reason;
  } });
  const loader = await plugin.auth.loader(auth);
  await assert.rejects(loader.fetch(RESPONSES_API + '/responses', { method: 'POST', body, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});
