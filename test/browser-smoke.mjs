import { beginBrowserSignIn } from '../browser-login.mjs';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
const choice = { id: '123', name: '浏览器回归测试 Key', group: '模拟分组', key: 'sk-fake-browser-only-1234' };
const flow = await beginBrowserSignIn({
  async login(username, password) {
    if (username !== 'demo' || password !== 'test-only') throw Error('fake credentials required');
    return { token: 'fake-browser-token', userId: '123' };
  },
  async listKeys() { return [choice]; },
  async complete() { return { type: 'success', key: choice.key, metadata: { keyId: choice.id } }; },
  errorMessage() { return '模拟测试请使用 demo / test-only，不要输入真实账号'; },
}, { signal: controller.signal });
console.log(JSON.stringify({ url: flow.url, mockOnly: true }));
const result = await flow.callback();
console.log(JSON.stringify({ result: result.type, selectedId: result.metadata?.keyId }));
if (result.type !== 'success') process.exitCode = 1;
