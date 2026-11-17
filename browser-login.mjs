import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const MAX_FORM_BYTES = 16 * 1024;

function html(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function page(content, error = '') {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>V2code · Magpie 登录</title><style>
  body{background:#f3f5f8;color:#182132;font:16px/1.6 system-ui,sans-serif;margin:0;padding:40px 16px}main{max-width:520px;margin:auto;background:white;border-radius:18px;padding:32px;box-shadow:0 12px 50px #18213212}h1{font-size:25px;margin-top:0}label{display:block;margin-top:20px;font-weight:600}input,select,button{box-sizing:border-box;font:inherit;width:100%;padding:12px;border:1px solid #ccd3df;border-radius:9px;margin-top:6px}button{background:#235ee8;color:white;border:0;margin-top:24px;cursor:pointer}.note{font-size:14px;color:#526078}.error{background:#fff0f0;color:#ad2424;padding:12px;border-radius:9px}a{color:#235ee8}
  </style></head><body><main><h1>V2code · Magpie</h1>${error ? `<p class="error" role="alert">${html(error)}</p>` : ''}${content}</main></body></html>`;
}

async function formOf(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_FORM_BYTES) throw Error('form too large');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export async function beginBrowserSignIn(service, { signal, ttlMs = 300000 } = {}) {
  const path = '/' + randomBytes(24).toString('hex');
  const csrf = randomBytes(24).toString('hex');
  const controller = new AbortController();
  let session;
  // Held only between the login and the key selection, and only when the
  // reader ticked the box. Cleared on every failure, cancel and finish.
  let remembered;
  let choices = new Map();
  let busy = false;
  let finished = false;
  let origin;
  let timer;
  let settle;
  const outcome = new Promise(resolve => { settle = resolve; });
  const removers = [];
  const hidden = `<input type="hidden" name="csrf" value="${csrf}">`;
  const loginPage = error => page(`<p>使用官网账号登录，然后手动选择一个已有 API Key。</p><form method="post" action="${path}/login">${hidden}<label for="username">官网账号</label><input id="username" name="username" autocomplete="username" required maxlength="200"><label for="password">官网密码</label><input id="password" name="password" type="password" autocomplete="off" required maxlength="4096"><label class="check"><input name="remember" type="checkbox" value="1" style="width:auto;margin:0 8px 0 0">保存官网账号密码，在官网令牌过期时自动重新登录（默认不勾选）</label><p class="note warn">勾选后，账号和密码会以明文保存在 Magpie 的本机账号文件中，任何能读取该文件的程序都能获得官网密码。官网要求验证码或二次验证时自动登录会失败。不勾选则不保存。</p><button type="submit">登录并读取 Key 列表</button></form><p class="note">账号密码仅发送至 <strong>https://www.v2code.ai</strong>。默认不保存密码；只保存最终选中的模型 Key 和官网登录令牌。此本机页面 5 分钟内有效。</p>`, error);
  const selectPage = () => page(`<p>已登录。请选择要交给 Magpie 使用的 Key：</p><form method="post" action="${path}/select">${hidden}<label for="selection">API Key（名称 · 分组 · 尾号）</label><select id="selection" name="selection" required><option value="" disabled selected>请手动选择一个 Key</option>${[...choices].map(([id, choice]) => `<option value="${id}">${html(choice.name)} · ${html(choice.group)} · …${html(choice.key.slice(-4))}</option>`).join('')}</select><button type="submit">使用选中的 Key</button></form><p class="note">只显示启用、未过期且有可用额度的 Key，不会创建、修改或删除 Key。官网余额是整个账号的余额，不等于某个 Key 的限额。</p>`);
  const send = (response, status, body) => {
    response.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'referrer-policy': 'same-origin',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      connection: 'close',
    });
    response.end(body);
  };
  const finish = result => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    for (const remove of removers) remove();
    controller.abort();
    choices.clear();
    session = undefined;
    remembered = undefined;
    server.close();
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    settle(result);
  };
  const watch = abortSignal => {
    if (!abortSignal || finished) return;
    const aborted = () => finish({ type: 'failed', error: 'V2code 登录已取消，请重新开始' });
    if (abortSignal.aborted) aborted();
    else {
      abortSignal.addEventListener('abort', aborted, { once: true });
      removers.push(() => abortSignal.removeEventListener('abort', aborted));
    }
  };
  const server = createServer(async (request, response) => {
    if (finished) return send(response, 410, page('<p>登录已结束，请返回 Magpie。</p>'));
    if (request.headers.host !== new URL(origin).host || ![path, `${path}/login`, `${path}/select`].includes(request.url)) {
      return send(response, 404, page('<p>无效的登录地址。</p>'));
    }
    if (request.method === 'GET' && request.url === path) {
      return send(response, 200, session ? selectPage() : loginPage());
    }
    if (request.method !== 'POST') return send(response, 405, page('<p>不支持的请求方式。</p>'));
    if (request.headers.origin !== origin || (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')
      || !String(request.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
      return send(response, 403, page('<p>请求来源不匹配，请从 Magpie 重新打开登录页。</p>'));
    }
    let form;
    try { form = await formOf(request); }
    catch { return send(response, 400, page('<p>登录表单无效或过大。</p>')); }
    if (finished) return;
    if (form.get('csrf') !== csrf) return send(response, 403, page('<p>登录校验失败，请重新打开登录页。</p>'));
    if (busy) return send(response, 409, page('<p>正在处理上一次请求，请勿重复提交。</p>'));
    busy = true;
    try {
      if (request.url === `${path}/login`) {
        if (session) return send(response, 409, selectPage());
        const username = form.get('username')?.trim();
        const password = form.get('password');
        if (!username || username.length > 200 || !password || password.length > 4096) {
          return send(response, 400, loginPage('请填写有效的官网账号和密码'));
        }
        const authenticated = await service.login(username, password, controller.signal);
        const remember = form.get('remember') === '1';
        form.delete('password');
        if (finished) return;
        const keys = await service.listKeys(authenticated, controller.signal);
        if (finished) return;
        session = authenticated;
        remembered = remember ? { username, password } : undefined;
        choices = new Map(keys.map(choice => [randomBytes(16).toString('hex'), choice]));
        if (!choices.size) throw Error('empty key list');
        return send(response, 200, selectPage());
      }
      if (request.url === `${path}/select`) {
        const selected = choices.get(form.get('selection'));
        if (!session || !selected) return send(response, 400, page('<p>未选择有效的 Key，请返回登录页选择。</p>'));
        const current = (await service.listKeys(session, controller.signal)).find(choice => choice.id === selected.id && choice.key === selected.key);
        if (finished) return;
        if (!current) {
          session = undefined;
          remembered = undefined;
          choices.clear();
          return send(response, 409, loginPage('所选 Key 已失效或发生变化，请重新登录并选择'));
        }
        const result = await service.complete(session, current, controller.signal, remembered);
        remembered = undefined;
        if (finished) return;
        response.once('finish', () => finish(result));
        return send(response, 200, page('<h2>已完成选择</h2><p>请返回 Magpie 等待登录完成。现在可以关闭此页面。</p>'));
      }
      return send(response, 404, page('<p>无效的登录操作。</p>'));
    } catch (error) {
      if (!finished) {
        session = undefined;
        remembered = undefined;
        choices.clear();
        send(response, 400, loginPage(service.errorMessage(error)));
      }
    } finally {
      form.delete('password');
      busy = false;
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 20000;
  server.maxConnections = 8;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  timer = setTimeout(() => finish({ type: 'failed', error: 'V2code 登录页面已超时，请重新开始' }), ttlMs);
  timer.unref?.();
  watch(signal);
  return {
    url: origin + path,
    method: 'auto',
    instructions: '在打开的本机页面输入 V2code 官网账号密码，登录后手动选择一个 Key；默认不保存密码，仅在你勾选“保存官网账号密码”时保存并用于令牌过期后的自动续登。',
    async callback(code, options = {}) {
      watch(options.signal);
      return outcome;
    },
  };
}
