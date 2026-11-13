# V2code 本地 Magpie 插件

在同一 `v2code` 供应商中调用模型并显示官网账户余额。无 npm 依赖、无常驻额外后台服务，不保存官网密码。

## 安装与登录

```sh
magpie plugin add https://github.com/sijinhui/magpie-v2code
```

1. 运行上面的命令从 GitHub 安装；也可在 Magpie → 插件 → 添加插件中填写仓库地址。开发时可选择本地文件夹，或运行 `magpie plugin add <本文件夹的绝对路径>`。
2. 在插件供应商 V2code 中选择“官网账号密码登录 → 手动选择已有 Key（推荐）”。
3. Magpie 打开临时本机登录页。输入官网账号密码，登录后在下拉列表中按 **名称、分组和尾号** 选择一个已有 Key，不需要复制、粘贴或输入模型 Key。
4. 点击“使用选中的 Key”，等待 Magpie 完成登录。本机页面会关闭监听，之后可关闭浏览器标签页。插件只保存选中的模型 Key、官网登录 JWT、用户 ID 与 Key 的标识/名称/分组，不保存账号密码，不保存未选中的 Key。
5. 仍保留“模型 API Key + 官网登录令牌”手动导入和“仅模型 API Key”两种备用方式。后者余额显示未配置，不伪造为零。

账号密码方式使用已有 Key，不会创建、删除、修改 Key。列表只包含启用、未过期且不限额或仍有可用额度的 Key；超过 2000 条、列表读取过程中变化或无法确认完整 Key 时明确报错，不默认挑选第一把。提交选择时再查询一次列表，防止使用刚被停用、过期或更换的 Key。遇到验证码或官网拒绝登录时，不尝试绕过或反复重试，可改用手动导入方式。

本机登录页仅监听 `127.0.0.1` 随机端口，带随机路径、表单 CSRF 校验和严格来源校验；密码输入框为掩码，页面不缓存、不展示完整 Key/JWT，5 分钟超时或取消后关闭。不要在不属于本机地址的仿冒页输入账号密码。插件代理或本机其他恶意程序的风险不由本页面解决。

取得官网令牌：自己在 `https://www.v2code.ai` 登录，打开浏览器开发者工具 → 网络 → 查看 `app_admin/user/data` 请求的 `Authorization` 请求头；复制其中的 `eyJ…`，不加 `Bearer `。也可在应用 → 本地存储 → `https://www.v2code.ai` 中复制 `token`。不需要提供密码、Cookie 或完整 HAR 文件。

**JWT 与模型 API Key 都是敏感凭据。** 不要发到聊天、截图、工单、源码或 Git 仓库。JWT 是官网账号登录态，不保证只有余额读取权限。Magpie 将它保存在账号 metadata，与 API Key 一样保存在本机私密账号文件中；这不等于加密保险箱。插件不扫描浏览器、不自动提取令牌、不读取其他供应商账号。遇到令牌失效，对 Magpie 中的同一账号“重新登录”即可重新认证、选择 Key；也可手动导入新令牌。不保存密码，不实现未经验证的自动续期。

## 从现有自定义供应商迁移

不要直接删除原供应商或修改路由。先备份，再将原模型 Key 登录到插件账号；确认余额和端点后，原 `providers.json` 中 `id: "v2code"` 的条目仅保留名称、图标、已选模型、路由偏好等非凭据设置，移除旧 `key`、`responses`、`anthropic`、`baseAPI` 等模型连接设置，由插件接管。保留所有 `groups` 及其他供应商原样。

在旧自定义供应商仍带 Key/端点时，Magpie 可能把插件显示为 `v2code-plugin`，不能因此把路由也改成新 ID。正式迁移应在账号登录和备份完成后进行，并停用再启用本插件，使正在运行的网关加载新账号。不要给插件启用只支持直接 Key 供应商的 `nativeCompaction`。

## 端点与行为

- 供应商 ID 固定为 `v2code`。GPT 使用 `https://dev.v2code.ai/v1/responses`；Claude 使用 `https://jp.v2code.ai/v1/messages`，支持同节点的 `/v1/messages/count_tokens`。
- 官网账号认证为 `POST https://www.v2code.ai/api/v1/app_admin/user/login`，JSON 为 `username`、`password`；只在当前登录请求中使用密码。`data.jwt_token` 和 `data.user_id` 交叉核对后用于官网接口。Key 列表为 `POST https://www.v2code.ai/api/v1/app_admin/token/list`，JSON 为 `page`、`page_size`，解析 `data.rows`、`data.total`。官网原始 Key 无前缀时按官网复制行为补 `sk-`；已有前缀不重复补。
- 模型列表从 `GET https://dev.v2code.ai/v1/models` 读取，最终只列出账号实际返回的 GPT/Claude 模型。其他协议族不猜测端点、不显示。
- `models.mjs` 是 2026-11-13 本机 models.dev 缓存中现有两个已选模型的能力快照，不保证中转站支持全部能力。其他模型沿用 Magpie 已有元数据，未知能力不虚构。不声明未经验证的价格。
- 余额使用 `POST https://www.v2code.ai/api/v1/app_admin/user/data`，请求头 `Authorization: <JWT>`（无 Bearer 前缀）、`User-Id: <ID>`。请求体为 Asia/Shanghai 当天的 `start_time`、`end_time`（Unix 秒）和 `default_time: "day"`。
- `data.quota` 为剩余，`data.used_quota` 为累计已用；历史总额与官网一致按两者之和显示。账户余额按预付钱包处理，不伪造每月限额、重置时间或过期时间。显示单位为站内额度，不声称是可提现美元。
- 余额错误不清除模型登录态；字段缺失、限流、验证页等显示错误，不把未知余额当零。仅余额验证，不进行模型生成或充值。
- 模型请求只放行上述固定 HTTPS 目标和 POST 接口，不跟随重定向；移除 Cookie、官网 User-Id、旧鉴权和 Magpie 内部头，重新设置模型 Key。官网 JWT 只用于官网余额请求，绝不附加到模型请求。
- 响应体上限 1 MiB，余额/模型列表超时 20 秒；模型流式请求原样透传，不缓冲回复，不改工具字段，不修改模型 ID。

## 验证

`npm test` 运行 Node.js 测试，需要 Node.js 22.15+。测试仅使用虚构账号、Key/JWT 和模拟官网接口，不读取真实账号；本机登录页测试需要允许回环网络。`npm run test:host` 可通过环境变量指定本机 Magpie/Bun，在隔离目录中测试真实宿主。验证记录及变量设置见 `VALIDATION.md`。

接口依据：2026-11-13 官网公开前端代码、已成功的官网余额请求，以及 Magpie 0.1.4066 插件 host。站点私有接口可能变更，需相应维护。使用本地目录安装时，插件按目录原地加载，请勿移动或删除已安装目录。
