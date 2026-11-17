import { modelDefaults } from './models.mjs';
import { beginBrowserSignIn } from './browser-login.mjs';

const PROVIDER = 'v2code';
const RESPONSES_API = 'https://dev.v2code.ai/v1';
const ANTHROPIC_API = 'https://jp.v2code.ai/v1';
const BALANCE_URL = 'https://www.v2code.ai/api/v1/app_admin/user/data';
const LOGIN_URL = 'https://www.v2code.ai/api/v1/app_admin/user/login';
const KEYS_URL = 'https://www.v2code.ai/api/v1/app_admin/token/list';
const MAX_JSON_BYTES = 1024 * 1024;
const MODEL_ID = /^(?:gpt-|claude-)[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/;

class ServiceError extends Error {}

function apiKey(auth) {
  if (auth?.type !== 'api' || typeof auth.key !== 'string' || !auth.key.trim()) {
    throw new ServiceError('请在 V2code 中配置模型 API Key');
  }
  const key = auth.key.trim();
  if (key.length > 4096 || /[\x00-\x20\x7f]/.test(key)) throw new ServiceError('模型 API Key 格式不正确');
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) {
    throw new ServiceError('请勿把官网登录令牌作为模型 API Key，二者必须分开填写');
  }
  return key;
}

function webSession(token, userId, now) {
  if (typeof token !== 'string' || !token.trim()) {
    throw new ServiceError('未配置官网余额认证：请重新登录 V2code 插件（或手动导入官网登录令牌）；模型 Key 不受影响');
  }
  const value = token.trim();
  if (value.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
    throw new ServiceError('官网登录令牌格式不正确，请复制登录后的 token，不是模型 API Key');
  }
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(value.split('.')[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    throw new ServiceError('官网登录令牌不是有效的 JWT');
  }
  if (header?.alg !== 'HS256' || claims?.account_type !== 'app_admin') {
    throw new ServiceError('这不是 V2code 官网账号的登录令牌');
  }
  const account = String(claims.account_id ?? '');
  if (!/^[1-9][0-9]{0,19}$/.test(account) || (userId != null && String(userId) !== account)) {
    throw new ServiceError('官网用户 ID 与登录令牌不匹配');
  }
  if (typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp <= 0) {
    throw new ServiceError('官网登录令牌缺少有效的到期时间');
  }
  if (claims.exp * 1000 <= now) {
    throw new ServiceError('官网余额登录令牌已过期，请重新登录 V2code 插件；模型 Key 不受影响');
  }
  return { token: value, userId: account };
}

function safeNumber(value, field) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') {
    throw new ServiceError(`余额回复缺少 ${field}，未按零处理`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw new ServiceError(`余额回复的 ${field} 不是有效数字`);
  return number;
}

function usageOf(data) {
  const remaining = safeNumber(data?.quota, 'quota');
  const used = safeNumber(data?.used_quota, 'used_quota');
  if (used < 0 || !Number.isFinite(remaining + used)) throw new ServiceError('余额回复的累计额度无效');
  // The website's selected-range spend is statistics_quota, not the
  // lifetime used_quota. A missing daily statistic must not hide the wallet.
  let today;
  try {
    const value = safeNumber(data?.statistics_quota, 'statistics_quota');
    if (value >= 0) today = value;
  } catch { /* Keep unknown statistics distinct from a known zero. */ }
  return {
    plan: 'V2code 预付额度',
    balance: remaining.toFixed(2),
    windows: [{
      name: '账户余额',
      balance: remaining,
      unit: '额度',
      display: `剩余 ${remaining.toFixed(2)} 额度`,
    }, {
      name: '今日用量',
      ...(today !== undefined ? { amount: today } : {}),
      unit: '额度',
      display: today !== undefined ? `今日已用 ${today.toFixed(2)} 额度` : '今日用量暂不可用',
      aside: true,
    }, {
      name: '累计使用',
      amount: used,
      unit: '额度',
      display: `已用 ${used.toFixed(2)} · 历史总额 ${(remaining + used).toFixed(2)} 额度`,
      aside: true,
    }],
    signIn: 'kept',
  };
}

function queryWindow(now) {
  const shifted = new Date(now + 8 * 3600000);
  const date = shifted.toISOString().slice(0, 10);
  const start = Date.parse(`${date}T00:00:00+08:00`) / 1000;
  return { start_time: start, end_time: start + 86400 - 1, default_time: 'day' };
}

function endpointOf(id) {
  if (id.startsWith('claude-')) return { npm: '@ai-sdk/anthropic', api: ANTHROPIC_API };
  return { npm: '@ai-sdk/openai', api: RESPONSES_API };
}

function keysOf(rows, now) {
  const seen = new Set();
  const keys = [];
  for (const row of rows) {
    if (!row || row.status !== 1 || !['string', 'number'].includes(typeof row.id)) continue;
    const id = String(row.id);
    if (!/^[1-9][0-9]{0,19}$/.test(id) || seen.has(id)) throw new ServiceError('Key 列表包含重复或无效的标识，请在官网检查');
    seen.add(id);
    const expiry = Number(row.expired_time);
    if (row.expired_time == null || !Number.isSafeInteger(expiry) || (expiry !== -1 && expiry * 1000 <= now)) continue;
    if (row.unlimited_quota !== true && row.unlimited_quota !== 1) {
      if (!['number', 'string'].includes(typeof row.remain_quota) || !Number.isFinite(Number(row.remain_quota)) || Number(row.remain_quota) <= 0) continue;
    }
    if (typeof row.key !== 'string' || row.key.includes('*') || row.key.includes('…') || /^eyJ[^.]+\.[^.]+\.[^.]+$/.test(row.key)) continue;
    let key;
    try { key = apiKey({ type: 'api', key: row.key.startsWith('sk-') ? row.key : 'sk-' + row.key }); }
    catch { continue; }
    if (key.length < 12) continue;
    const label = (value, fallback) => typeof value === 'string' && value.trim() ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100) : fallback;
    keys.push({ id, key, name: label(row.name, `Key ${id}`), group: label(row.group, '未标注分组') });
  }
  return keys;
}

async function readJson(response, label) {
  if (!response.ok) {
    await response.body?.cancel();
    const message = label === 'V2code 余额查询' && [401, 403].includes(response.status)
      ? '官网余额认证被拒绝，请重新登录 V2code 插件；模型 Key 不受影响'
      : `${label}失败（HTTP ${response.status}）`;
    throw new ServiceError(message);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ServiceError(`${label}未返回数据`);
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new ServiceError(`${label}回复过大`);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ServiceError(`${label}未返回有效 JSON，可能遇到官网验证页`); }
}

function createPlugin({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  async function request(url, init, label, signal) {
    try {
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(20000);
      const response = await fetchImpl(url, {
        ...init,
        credentials: 'omit',
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      return await readJson(response, label);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(`${label}连接失败、已取消或超时，请检查网络或代理`);
    }
  }

  async function readUsage(auth, signal) {
    apiKey(auth);
    const session = webSession(auth.metadata?.webToken, auth.metadata?.webUserId, now());
    const result = await request(BALANCE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: session.token, 'user-id': session.userId },
      body: JSON.stringify(queryWindow(now())),
    }, 'V2code 余额查询', signal);
    if (result?.status !== 0) {
      if (result?.status === 101) {
        throw new ServiceError('官网余额认证失效，请重新登录 V2code 插件；模型 Key 不受影响');
      }
      throw new ServiceError('V2code 官网拒绝余额查询，未将未知余额记为零');
    }
    return usageOf(result.data);
  }

  async function siteRequest(url, body, session, label, signal) {
    const result = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(session ? { authorization: session.token, 'user-id': session.userId } : {}) },
      body: JSON.stringify(body),
    }, label, signal);
    if (result?.status !== 0) throw new ServiceError(`${label}被官网拒绝，请检查登录信息、验证码要求或账号权限`);
    return result.data;
  }

  const browserService = {
    async login(username, password, signal) {
      const data = await siteRequest(LOGIN_URL, { username, password }, null, 'V2code 账号登录', signal);
      return webSession(data?.jwt_token, data?.user_id, now());
    },
    async listKeys(session, signal) {
      const rows = [];
      let total;
      for (let page = 1; page <= 20; page++) {
        const data = await siteRequest(KEYS_URL, { page, page_size: 100 }, session, 'V2code Key 列表', signal);
        if (!Array.isArray(data?.rows) || !Number.isSafeInteger(data.total) || data.total < 0 || data.total > 2000) {
          throw new ServiceError('Key 列表格式不正确或超过 2000 条，请在官网整理后重试');
        }
        if (total !== undefined && total !== data.total) throw new ServiceError('Key 列表在读取过程中发生变化，请重新登录');
        total = data.total;
        rows.push(...data.rows);
        if (rows.length > total || (rows.length < total && data.rows.length === 0)) throw new ServiceError('Key 列表分页数据不完整，请重试');
        if (rows.length === total) {
          const keys = keysOf(rows, now());
          if (!keys.length) throw new ServiceError('账号下没有启用、未过期且有可用额度的完整 Key，请先在官网检查');
          return keys;
        }
      }
      throw new ServiceError('Key 列表分页过多，请在官网整理后重试');
    },
    async complete(session, selected, signal) {
      const metadata = { webToken: session.token, webUserId: session.userId, keyId: selected.id, keyName: selected.name, keyGroup: selected.group };
      await readUsage({ type: 'api', key: selected.key, metadata }, signal);
      return { type: 'success', key: selected.key, metadata };
    },
    errorMessage(error) { return error instanceof ServiceError ? error.message : 'V2code 登录暂时失败，请返回重试；账号密码未保存'; },
  };

  return {
    config: async config => {
      config.provider ??= {};
      config.provider[PROVIDER] ??= {};
      const provider = config.provider[PROVIDER];
      provider.name ??= 'V2code';
      provider.npm ??= '@ai-sdk/openai';
      provider.api ??= RESPONSES_API;
      provider.models ??= {};
      for (const [id, defaults] of Object.entries(modelDefaults)) {
        provider.models[id] ??= { ...structuredClone(defaults), provider: endpointOf(id) };
      }
    },
    auth: {
      provider: PROVIDER,
      methods: [{
        type: 'oauth',
        label: '官网账号密码登录 → 手动选择已有 Key（推荐）',
        async authorize(inputs, options = {}) {
          try { return await beginBrowserSignIn(browserService, options); }
          catch { return { type: 'failed', error: '无法打开本机登录页面，请使用手动导入令牌的方式' }; }
        },
      }, {
        type: 'api',
        label: '模型 API Key + 官网登录令牌（查询余额，不保存密码）',
        prompts: [
          { type: 'text', key: 'key', message: 'V2code 模型 API Key', placeholder: 'sk-…' },
          { type: 'text', key: 'webToken', message: '官网登录令牌 token（不是 API Key；用户 ID 自动识别）', placeholder: 'eyJ…' },
        ],
        async authorize(inputs = {}, { signal } = {}) {
          try {
            const key = apiKey({ type: 'api', key: inputs.key });
            const session = webSession(inputs.webToken, undefined, now());
            const auth = { type: 'api', key, metadata: { webToken: session.token, webUserId: session.userId } };
            await readUsage(auth, signal);
            return { type: 'success', key, metadata: auth.metadata };
          } catch (error) {
            return { type: 'failed', error: error instanceof ServiceError ? error.message : 'V2code 登录认证失败' };
          }
        },
      }, {
        type: 'api',
        label: '仅模型 API Key（暂不查询余额）',
        placeholder: 'sk-…',
      }],
      async loader(getAuth) {
        return {
          apiKey: apiKey(await getAuth()),
          async fetch(input, init = {}) {
            const request = input instanceof Request ? new Request(input, init) : null;
            const url = new URL(request ? request.url : String(input));
            const method = (request?.method ?? init.method ?? 'GET').toUpperCase();
            const responses = url.origin === 'https://dev.v2code.ai' && url.pathname === '/v1/responses';
            const messages = url.origin === 'https://jp.v2code.ai'
              && ['/v1/messages', '/v1/messages/count_tokens'].includes(url.pathname);
            if ((!responses && !messages) || url.username || url.password || url.hash || url.search || method !== 'POST') {
              throw new ServiceError('V2code 插件拒绝向未知地址、协议端点或接口发送模型密钥');
            }
            const signal = request?.signal ?? init.signal;
            signal?.throwIfAborted();
            const key = apiKey(await getAuth());
            // Auth loading may await disk I/O. A canceled request must not
            // start a billed generation when that read finishes.
            signal?.throwIfAborted();
            const headers = new Headers(request ? request.headers : init.headers);
            for (const name of [...headers.keys()]) {
              if (['authorization', 'x-api-key', 'cookie', 'cookie2', 'user-id', 'host', 'content-length', 'origin', 'referer', 'proxy-authorization', 'x-auth-token', 'x-access-token'].includes(name)
                || name.startsWith('x-magpie-')) headers.delete(name);
            }
            headers.set('authorization', `Bearer ${key}`);
            if (messages) {
              headers.set('x-api-key', key);
              if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
            }
            const options = { ...init, method, headers, credentials: 'omit', redirect: 'error', signal };
            if (request) options.body = request.body;
            if (options.body instanceof ReadableStream) options.duplex = 'half';
            return fetchImpl(url.href, options);
          },
        };
      },
      async usage(getAuth, provider, { signal } = {}) {
        try { return await readUsage(await getAuth(), signal); }
        catch (error) {
          return { error: error instanceof ServiceError ? error.message : 'V2code 余额读取失败', windows: [], signIn: 'kept' };
        }
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth, signal } = {}) {
        if (auth?.type !== 'api') return provider.models;
        const result = await request(`${RESPONSES_API}/models`, {
          headers: { authorization: `Bearer ${apiKey(auth)}` },
        }, 'V2code 模型列表', signal);
        if (!Array.isArray(result?.data) || !result.data.length) throw new ServiceError('V2code 模型列表为空或格式不正确');
        const models = Object.create(null);
        for (const item of result.data) {
          if (typeof item?.id !== 'string' || !MODEL_ID.test(item.id)) continue;
          const id = item.id;
          const previous = Object.hasOwn(provider.models ?? {}, id) ? (provider.models[id] ?? {}) : {};
          const endpoint = endpointOf(id);
          const name = [item.name, previous.name, id].find(value => typeof value === 'string' && value.trim());
          models[id] = {
            ...previous,
            id,
            providerID: PROVIDER,
            name: name.slice(0, 200),
            status: 'active',
            api: { id, url: endpoint.api, npm: endpoint.npm },
            limit: previous.limit ?? { context: 0, output: 0 },
            capabilities: previous.capabilities ?? {},
          };
        }
        if (!Object.keys(models).length) throw new ServiceError('V2code 未返回可用的 GPT 或 Claude 模型');
        return models;
      },
    },
  };
}

export default async function V2codePlugin() { return createPlugin(); }
export const _internal = { createPlugin, webSession, usageOf, queryWindow, keysOf, RESPONSES_API, ANTHROPIC_API, BALANCE_URL, LOGIN_URL, KEYS_URL };
