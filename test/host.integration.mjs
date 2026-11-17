import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const bun = process.env.MAGPIE_TEST_BUN;
const host = process.env.MAGPIE_TEST_HOST;

test('real Magpie host supports manual import and browser login with key selection', { skip: !bun || !host, timeout: 30000 }, async context => {
  const directory = path.join(root, '.validation', `host-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  const wrapper = path.join(directory, 'host-wrapper.mjs');
  const authPath = path.join(directory, 'plugin-auth.json');
  await writeFile(authPath, '{}\n');
  await writeFile(wrapper, `
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === 'https://www.v2code.ai/api/v1/app_admin/user/login') {
    const body = JSON.parse(init.body);
    if (body.username !== 'fake-user' || body.password !== 'fake-password') throw Error('unexpected fake credentials');
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = encode({ alg: 'HS256' }) + '.' + encode({ account_type: 'app_admin', account_id: '123', exp: Math.floor(Date.now() / 1000) + 86400 }) + '.fake-signature';
    return Response.json({ status: 0, data: { jwt_token: token, user_id: 123 } });
  }
  if (url === 'https://www.v2code.ai/api/v1/app_admin/token/list') {
    return Response.json({ status: 0, data: { rows: [{ id: 1, name: '用于 Magpie', group: 'cc_plus', key: 'fake-only', status: 1, expired_time: -1, unlimited_quota: true }, { id: 2, name: '不要选择', group: 'other', key: 'unselected-secret', status: 1, expired_time: -1, unlimited_quota: true }], total: 2 } });
  }
  if (url === 'https://dev.v2code.ai/v1/models') return Response.json({ data: [{ id: 'gpt-6-astra' }, { id: 'claude-opus-5-5' }] });
  if (url === 'https://www.v2code.ai/api/v1/app_admin/user/data') {
    if (!String(new Headers(init.headers).get('authorization')).startsWith('eyJ') || new Headers(init.headers).get('user-id') !== '123') throw Error('missing fake website auth');
    return Response.json({ status: 0, data: { quota: 123.45, used_quota: 67.89, statistics_quota: 4.56 } });
  }
  throw Error('integration test refused unexpected network request');
};
await import(${JSON.stringify(pathToFileURL(host).href)});
`);
  const child = spawn(bun, [wrapper], { cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  let serial = 0;
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    const pending = waiting.get(message.id);
    if (!pending || message.event) return;
    waiting.delete(message.id);
    if (message.error) pending.reject(Error(message.error.message));
    else pending.resolve(message.result);
  });
  child.on('error', error => {
    for (const pending of waiting.values()) pending.reject(error);
    waiting.clear();
  });
  child.on('exit', code => {
    for (const pending of waiting.values()) pending.reject(Error(`host exited ${code}: ${stderr}`));
    waiting.clear();
  });
  context.after(() => { child.stdin.end(); child.kill(); lines.close(); });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    waiting.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });

  const init = await rpc('init', { authPath, directory, plugins: [{ spec: root, target: root }] });
  assert.equal(init.plugins.length, 1);
  assert.equal(init.plugins[0].error, undefined);
  let providers = await rpc('providers');
  assert.equal(providers.length, 1);
  assert.equal(providers[0].id, 'v2code');
  assert.equal(providers[0].icon, 'https://www.v2code.ai/favicon.ico');
  assert.equal(providers[0].usage, true);
  assert.equal(providers[0].methods[0].type, 'oauth');
  assert.equal(providers[0].methods[1].keyAsked, true);
  assert.deepEqual((await rpc('prompt', { provider: 'v2code', method: 1 })).prompt.key, 'key');
  assert.equal((await rpc('prompt', { provider: 'v2code', method: 1, inputs: { key: 'sk-fake-only' } })).prompt.key, 'webToken');
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'HS256' })}.${encode({ account_type: 'app_admin', account_id: '123', exp: Math.floor(Date.now() / 1000) + 86400 })}.fake-signature`;
  const login = await rpc('apiKey', { provider: 'v2code', method: 1, inputs: { key: 'sk-fake-only', webToken: token } });
  assert.equal(login.ok, true);
  assert.equal(login.provider, 'v2code');
  const saved = JSON.parse(await readFile(authPath, 'utf8'));
  assert.equal(saved[login.account].key, 'sk-fake-only');
  assert.equal(saved[login.account].metadata.webToken, token);
  assert.equal(saved[login.account].metadata.webUserId, '123');
  providers = await rpc('providers');
  assert.equal(providers[0].signedIn, true);
  assert.equal(providers[0].models.length, 2);
  const gpt = providers[0].models.find(model => model.id === 'gpt-6-astra');
  const claude = providers[0].models.find(model => model.id === 'claude-opus-5-5');
  assert.equal(gpt.url, 'https://dev.v2code.ai/v1');
  assert.equal(gpt.npm, '@ai-sdk/openai');
  assert.equal(gpt.context, 1050000);
  assert.equal(claude.url, 'https://jp.v2code.ai/v1');
  assert.equal(claude.npm, '@ai-sdk/anthropic');
  assert.equal(claude.context, 1000000);
  const usage = await rpc('usage', { provider: 'v2code', account: login.account });
  assert.equal(usage.balance, '123.45');
  assert.equal(usage.windows[0].balance, 123.45);
  assert.equal(usage.windows[0].used, null);
  assert.equal(usage.windows[1].name, '今日用量');
  assert.equal(usage.windows[1].amount, 4.56);
  assert.equal(usage.windows[1].display, '今日已用 4.56 额度');
  assert.equal(usage.windows[1].unit, '额度');
  assert.equal(usage.windows[1].used, null);
  assert.equal(usage.windows[1].aside, true);
  assert.equal(usage.windows[2].name, '累计使用');
  assert.equal(usage.windows[2].amount, 67.89);
  assert.equal(usage.signIn, 'kept');
  assert.equal(JSON.stringify(usage).includes(token), false);
  const load = await rpc('load', { provider: 'v2code', account: login.account });
  assert.equal(load.fetch, true);
  assert.equal(load.apiKey, 'sk-fake-only');
  const browser = await rpc('authorize', { provider: 'v2code', method: 0, account: login.account });
  assert.equal(browser.ok, true);
  assert.equal(browser.method, 'auto');
  const page = await (await fetch(browser.url)).text();
  assert.match(page, /name="password" type="password"/);
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1];
  const headers = { origin: new URL(browser.url).origin, 'content-type': 'application/x-www-form-urlencoded' };
  const optionsPage = await (await fetch(browser.url + '/login', { method: 'POST', headers, body: new URLSearchParams({ csrf, username: 'fake-user', password: 'fake-password' }) })).text();
  assert.match(optionsPage, /用于 Magpie/);
  assert.equal(optionsPage.includes('unselected-secret'), false);
  assert.equal(optionsPage.includes('sk-fake-only'), false);
  const selection = /<option value="([a-f0-9]+)">/.exec(optionsPage)[1];
  const callback = rpc('callback', { session: browser.session });
  const selected = await fetch(browser.url + '/select', { method: 'POST', headers, body: new URLSearchParams({ csrf, selection }) });
  assert.equal(selected.status, 200);
  assert.match(await selected.text(), /已完成选择/);
  const completed = await callback;
  assert.equal(completed.ok, true);
  assert.equal(completed.account, login.account);
  const browserSaved = await readFile(authPath, 'utf8');
  const finalAuth = JSON.parse(browserSaved)[login.account];
  assert.equal(finalAuth.key, 'sk-fake-only');
  assert.equal(finalAuth.metadata.keyId, '1');
  assert.equal(browserSaved.includes('fake-password'), false);
  assert.equal(browserSaved.includes('fake-user'), false);
  assert.equal(browserSaved.includes('unselected-secret'), false);
});
