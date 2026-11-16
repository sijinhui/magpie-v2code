# 验证记录

## 2026-11-16 空响应排查

- 新增 `test/model-response.test.mjs`，使用内存 Response 和虚构 Key，覆盖 UTF-8/JSON 分块、文本、纯工具输出、真实空完成、仅 completed 带文本、仅 reasoning、failed/incomplete、截断事件、上游 HTTP 502、请求预算/状态透传及取消不重试。
- 这些用例只验证插件传输边界，不验证 Magpie 的 Messages → Responses → Messages 转换，也不能据此声称真实空响应已修复。
- `node --check test/model-response.test.mjs` 与 `git diff --check` 通过。完整测试执行被本机自动审批以 `Code from External` 拒绝，新增用例尚未运行；本次没有真实模型生成或线上修复验证。
- 排查发现同一输入在多个渠道的同一模型上均出现空响应；现有汇总日志不足以确定上游真实空 output 或宿主解析问题，后续需要脱敏上游终止事件佐证。没有改写模型响应或增加自动重试。

## 2026-11-13 验证记录

## 自动测试

- 33 项 Node.js 测试通过：余额字段、零余额/负余额/缺失字段、上海日期、官网与模型凭据分流、JWT 格式/用户 ID/到期时间、HTTP 错误、响应体大小上限、取消、模型流式透传、工具字段、动态模型 Key 和端点白名单。
- 登录流程覆盖本机表单密码掩码、来源与 CSRF 防护、HTML 转义、超大表单拒绝、取消/超时关闭、Key 状态/到期/额度筛选、分页、提交时再验证，以及只保存选中的 Key。
- 测试数据均为虚构账号、Key/JWT 和额度；自动测试不读取真实账号、不访问官网登录接口、不执行模型生成。
- Magpie 0.1.4066 plugin host / Bun 1.4.4 隔离集成测试通过。宿主 authorize/callback 能完成浏览器式登录和选 Key；手动导入方式也保持兼容。
- 集成测试确认账号文件不含密码、登录账号及未选中的 Key，余额窗口按预付钱包表示，GPT/Claude 分别使用正确的 Responses/Anthropic 端点，插件图标字段可被宿主识别。

## 浏览器与只读接口验证

- 在 Chrome 中使用虚构 demo 账号测试原生 HTML 表单：能进入模拟 Key 选择页、完成选择，测试进程返回 success。未输入真实账号密码，没有调用真实官网登录接口。
- 官网公开前端脚本确认 `user/login`、`token/list`、`user/data` 的请求方式与字段，以及复制模型 Key 时使用的 `sk-` 前缀。
- 一次真实只读模型列表检查返回 16 个 GPT/Claude 模型，其中包括 `gpt-6-astra`、`claude-opus-5-5`。未执行真实模型生成。
- 官网图标返回 HTTP 200、image/x-icon，宿主集成测试确认 `magpie.icon` 配置正确。

## 修复记录

- 0.2.2：补充 `package.json` 的 `magpie.icon`，使用官网 favicon。
- 0.2.1：本机登录页从 `Referrer-Policy: no-referrer` 改为 `same-origin`，修复浏览器原生 POST 表单的 `Origin: null` 被误拒绝的问题。没有放宽来源校验：null/缺失 Origin、跨源、错误 CSRF 仍拒绝。
- 0.2.0：增加“账号密码登录 → 手动选择已有 Key”。密码只在当前登录请求中使用，不保存、不自动续登；最终只保存选中的模型 Key、官网 JWT 与必要 metadata。

## 限制

- 尚未使用真实官网账号密码对新插件完成端到端登录/选 Key/余额验证，需用户亲自在本机页面操作。
- 未专项验证真实模型流式生成、工具调用后下一轮、最大上下文、长期运行和真实会话到期后的重新登录。
- 账号余额属于整个官网账号，不代表选中 Key 的独立限额。私有官网接口可能变化。

## 重跑

- `npm test`：自动测试，需要允许本机回环网络。
- `npm run test:host`：设置 `MAGPIE_TEST_BUN` 指向已安装的 `magpie-bun.exe`，`MAGPIE_TEST_HOST` 指向对应版本 `host-*.js`。未设置时明确跳过；测试只在 `.validation` 隔离目录中写入虚构账号。
- `node test/browser-smoke.mjs`：手动浏览器回归。打开输出的本机地址，使用 demo / test-only，选择模拟 Key；5 分钟超时。不要输入真实账号。

仓库不包含真实凭据、浏览器数据、个人余额快照、本机配置或测试运行目录。
