# QQ 官方机器人「扫码绑定」实现调研

> 调研时间：2026-10-25。目的是在 Node.js 项目里复刻「点连接 → 弹出二维码 → 手机 QQ 扫码 → 拿到 AppID/AppSecret」这条链路。
> 结论分级：**【官方】**=腾讯官方文档/官方页面原文；**【第三方】**=开源实现（可运行代码）；**【推测】**=基于前两者的推断。

---

## 一、结论摘要

1. **AstrBot 有完整实现**，协议与 hermes 完全一致：`POST q.qq.com/lite/create_bind_task` → 二维码指向 `q.qq.com/qqbot/openclaw/connect.html?task_id=...&_wv=2` → 每 2s `POST /lite/poll_bind_result` → AES-256-GCM 解 `bot_encrypt_secret` 拿 AppSecret。
2. **腾讯官方 API 文档里找不到 `/lite/*` 这两个接口**。但腾讯自己的 `tencent-connect/openclaw-qqbot` CLI 和 QQ 官方给 WorkBuddy 做的接入页都走「扫码绑定」，说明这是**官方在用、但未写进公开开发者文档**的内部通道。
3. **WorkBuddy 的「QQ 扫码」就是这个协议**：官方文档写的是「QQ 扫码：扫码连接**已创建**的机器人」，即用户先有 bot，客户端扫码把该 bot 的凭证拉回本地，然后本地起 WebSocket/Webhook。

---

## 二、AstrBot 的实现（主参考，代码可直接抄）

本地版本：`E:/myrepo/参考/AstrBot`，HEAD `832fc6d9`（2026-10-25）。
扫码模块由提交 `f1854df62 feat: add qq official qr binding`（2026-06-16）引入。

### 2.1 文件分布

| 文件 | 作用 |
| --- | --- |
| `astrbot/core/platform/sources/qqofficial/login_registration.py` | **全部协议逻辑**（273 行，无依赖，纯 httpx + pycryptodome） |
| `astrbot/dashboard/services/platform_service.py:200-233` | 把扫码包装成 `start` / `poll` 两个 action |
| `astrbot/dashboard/api/platform.py:78-87`、`:131-141` | HTTP 路由 `POST /bot-types/{bot_type}/registration` |
| `dashboard/src/components/platform/PlatformRegistrationAction.vue` | 前端轮询 + 把 appid/secret 写回表单 |
| `dashboard/src/components/shared/QrCodeViewer.vue:16` | 用 `qrcode` npm 包把 URL 渲染成图片 |
| `tests/test_qqofficial_login_registration.py` | 单测，可当协议样例 |

### 2.2 常量与状态码

`login_registration.py:12-19`：host `q.qq.com`、轮询间隔 **2s**、单次超时 **10s**；`status`：`0=NONE / 1=PENDING / 2=COMPLETED / 3=EXPIRED`。

### 2.3 协议四步

**① 本地生成 32 字节随机密钥**（`:93-100`）—— `base64.b64encode(secrets.token_bytes(32))`。这段 key **不发给服务器**，只发它的 base64，用于服务端加密回传 secret。

**② 创建绑定任务**（`:214-233`）：

```
POST https://q.qq.com/lite/create_bind_task
Content-Type: application/json
Accept: application/json

{"key": "<base64(32B)>"}
→ {"retcode": 0, "data": {"task_id": "..."}}
```

注意 `_post_json`（`:60-90`）统一走 `retcode` 判错：`retcode != 0` 时抛 `msg`/`message`，没有 `retcode` 字段也放行。

**③ 二维码内容就是一个 URL**（`:53-57`），`_wv=2` 是 QQ 内置 WebView 参数，扫码后打开 QQ 官方 H5 由用户确认授权：

```
https://q.qq.com/qqbot/openclaw/connect.html?task_id=<task_id>&_wv=2
```

**④ 轮询**（`:236-272`）：

```
POST https://q.qq.com/lite/poll_bind_result
{"task_id": "<task_id>"}

→ {"retcode":0, "data": {
      "status": 0|1|2|3,
      "bot_appid": "123456789",          // status=2 时
      "bot_encrypt_secret": "<base64>",  // status=2 时
      "user_openid": "..."               // 可选，扫码人 openid
   }}
```

`status` 映射在 `:136-188`：

| status | 含义 | AstrBot 返回 |
| --- | --- | --- |
| 0 | NONE | `pending` |
| 1 | PENDING（已扫未确认） | `pending` |
| 2 | COMPLETED | `created` + appid/secret |
| 3 | EXPIRED | `expired`，需重新建 task |

### 2.4 解密：AES-256-GCM，`IV(12) ‖ ciphertext ‖ tag(16)`

`login_registration.py:103-133` —— 布局 `nonce=raw[:12]`、`tag=raw[-16:]`、`ciphertext=raw[12:-16]`，`AES.new(key, AES.MODE_GCM, nonce).decrypt_and_verify(ciphertext, tag)`。单测 `tests/test_qqofficial_login_registration.py:25-49` 用同样布局构造密文，可交叉验证。

**Node.js 等价实现**（`node:crypto` 原生支持 GCM，无需三方库）：

```js
import crypto from 'node:crypto';
export function decryptSecret(encryptedB64, keyB64) {
  const key = Buffer.from(keyB64, 'base64'), raw = Buffer.from(encryptedB64, 'base64');
  if (key.length !== 32 || raw.length <= 28) throw new Error('凭证密文格式异常');
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8');
}
```

### 2.5 Dashboard 侧的对外契约

`platform_service.py:206-231` —— 前端只需两个 action，`bind_key` 由前端暂存（服务端无状态）：

```json
// start: {"action":"start","platform_config":{"type":"qq_official"}}
→ {"status":"pending","task_id":"...","bind_key":"...","qrcode":"https://q.qq.com/...","interval":2}
// poll:  {"action":"poll","task_id":"...","bind_key":"..."}
→ {"status":"created","appid":"...","secret":"...","platform_id_suffix":"_<appid>"}
```

前端 `PlatformRegistrationAction.vue:189-207` 用返回的 `interval`（默认 2s）做 `setTimeout` 递归轮询；`:242-256` 收到 `created` 停止并把 `appid`/`secret` 填进表单（`:268-283`）。二维码渲染在 `QrCodeViewer.vue:16`，把 URL 字符串交给 `qrcode` 库。

### 2.6 扫码拿到凭证之后

`qqofficial_platform_adapter.py:297-302` 只认 `appid`、`secret` 两个字段，传输层用 `botpy` 走 WebSocket，`intents` 由 `enable_group_c2c` / `enable_guild_direct_message` 决定（`:304-314`）；另有 `qqofficial_webhook` 变体支持 `unified_webhook_mode`。Markdown：`use_markdown` 默认 `True`，发送即 `{"markdown":{"content":...},"msg_type":2}`，失败走 `_send_with_markdown_fallback` 降级纯文本，带媒体时强制 `msg_type=7`（`:405-442`）。

### 2.7 AstrBot 文档已把扫码写成推荐路径

`docs/zh/platform/qqofficial/websockets.md` 原文：「## 在 AstrBot 中扫码一键创建 QQ 机器人（推荐）… 扫码确认后，AstrBot 会自动写入 `AppID` 和 `AppSecret`。」同页另注明手动路径的硬约束：需设 IP 白名单、沙箱群成员 ≤ 20 人。

---

## 三、腾讯官方文档核实结果

### 3.1 `/lite/create_bind_task` 是否有官方文档？——**没有**

- 在 `bot.q.qq.com/wiki` / `bot.qq.com` 的接入指南里，只列了 `https://bots.qq.com/app/getAppAccessToken`、`https://api.sgroup.qq.com/`、`https://sandbox.api.sgroup.qq.com` 三个域名，**未出现 `q.qq.com/lite/*`**（[介绍与接入指南](http://bot.qq.com)）。
- 多次站内检索「扫码绑定接口 / lite」均无官方条目。
- 判定：**这是腾讯内部/合作方通道，不是公开 OpenAPI**。多家独立实现（AstrBot、hermes-agent、`dsh-qq-notify`、`dsh-qqbot-lite`）协议完全一致，说明它稳定存在，但**随时可能变更且无 SLA**。

### 3.2 但它确实是官方在用的

- 腾讯官方开源插件仓库 `tencent-connect/openclaw-qqbot` 的安装向导第 4 步就是「Bind your bot」→ **Scan QR code（终端显示二维码，过期自动刷新）**，并在 README 里写「扫码后无需手动复制 AppID/AppSecret」。
- QQ 官方给 WorkBuddy 做的接入页 `https://q.qq.com/setup/` 第 4 步原文：「点击「配置」。**屏幕出现二维码后，使用手机 QQ 扫码确认**。」
- QQ 官方 Agent 接入页 `https://bot.qq.com/agent-qqbot/` 原文：「连接方式：推荐使用 **扫码绑定**，使用手机QQ扫码二维码，连接你的 QQ Bot，确认绑定即可。」

结论：扫码绑定是 QQ 侧主推的接入方式，`/lite/*` 是被官方客户端/合作方调用的**未公开接口**。（【官方】页面佐证 +【推测】接口归属）

### 3.3 机器人创建流程（官方现状）

来自 [QQ Bot 介绍与接入指南](https://bot.qq.com/wiki/)：

- 注册：QQ 扫码或邮箱，需**主体认证**（个人 / 企业；企业需营业执照 + 对公打款验证）。
- 创建：「点击「创建机器人」，填写昵称、简介即可」。**个人主体 5 个**，企业 10 个（同主体合计 50）。
- 服务范围：未认证只能加到自己是群主/管理员的群；个人认证进群上限 500；企业认证才能公开。
- 沙箱：沙箱频道/群/私聊成员 ≤ 20 人，沙箱期不受 IP 白名单限制。
- IP 白名单：新机器人**默认启用**，不填不能提审上线；只作用于正式环境，单 IPv4、最多 50 条。
- 连接方式：WebSocket（免公网，需长连）或 Webhook（公网 HTTPS + 签名校验），切换立即生效。
- Agent 直连：「高级设置 → 设置机器人服务」，可直接接入 **OpenClaw、WorkBuddy** 等 AI Agent 服务（wiki 第 7 节）。

### 3.4 Markdown 消息（`msg_type=2`）官方原文

[Markdown 消息文档](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/markdown.html) 首段（2026-10-25 直接抓取核实，逐字）：

> **2026/04/23 能力更新说明**
> 单聊场景、群聊场景自定义 Markdown 消息能力已开放到所有机器人均可使用，无需单独申请 Markdown 模版，频道场景目前需要内邀开通。

> 注意：网上流传的「沙箱环境，可使用自定义 Markdown 消息能力调试，其他环境，目前需要内邀开通」是**旧版文案**，当前页面已不存在该句。凡引用这句话的方案（包括早期版本的本文档）都已过期。

字段（同页）：`content`=自定义 markdown 文本、`custom_template_id`=申请审核后的模版 id、`params`=`{key, values}` 模板变量，三者均非必填、按需组合。

发送接口 [发送单聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html) 明确：

> `msg_type`：0=纯文本(content)、**2=Markdown(markdown)**、6=输入中、7=富媒体(media)
> 「传了 markdown 后 content 必须为空」「`msg_type=2` 时 markdown 必填」

因此：**单聊/群聊的原生 markdown（只给 `content`）已对全部机器人开放，无需申请、无需模板**；只有**频道（guild）场景**仍需内邀，走 `custom_template_id` 模板审核是另一条可选路线。所以默认可以直接 `msg_type=2 + markdown.content`，只需为频道场景保留「markdown → 纯文本」降级。

---

## 四、WorkBuddy 的「QQ 机器人」连接方式

### 4.1 官方原文

[WorkBuddy 接入 QQ 指南](https://www.codebuddy.cn/docs/workbuddy/QQ-Guide)（腾讯云文档同步版 [product/1003/134442](https://cloud.tencent.com.cn/document/product/1003/134442)）第四步：

> 打开 WorkBuddy，点击助理的设置⚙️图标后进入助理设置页面。
> 点击 **QQ 机器人**卡片右边的**连接**按钮。
> 选择一种方式连接已创建的 QQ 机器人
> - **QQ 扫码**：扫码连接**已创建**的机器人。
> - **更多连接方式**：选择 WebSocket 长连接或使用 URL 回调，填入上方复制保存的 AppID 和 AppSecret，点击连接按钮。

前置步骤明确要求：**先去 q.qq.com 创建机器人、复制 AppID/AppSecret**（并警告 AppSecret 二次查看会强制重置）。

[q.qq.com/setup/](https://q.qq.com/setup/)（QQ 官方为 WorkBuddy 做的落地页）：

> STEP 04 扫码完成连接：点击「配置」。屏幕出现二维码后，使用手机 QQ 扫码确认。
> 群聊模式注意：暂未适配 QQ 群全量消息模式。请保持「获取群内全部消息」关闭，否则机器人可能无法正常接收和回复 @ 消息。

### 4.2 协议判定

- 是**「扫码授权已存在的 bot」**，不是「扫码创建 bot」。二维码内容即 `q.qq.com/qqbot/openclaw/connect.html?task_id=...`，手机 QQ 打开后展示该账号下的机器人列表供选择/确认。（【官方】文档语义 +【推测】二维码内容，后者依据 AstrBot/hermes/两个第三方插件完全一致的实现）
- 扫码完成后 WorkBuddy 拿到 `appid` + `secret`，**在本地**起 WebSocket 长连接（默认）或注册 URL 回调 —— 所以「QQ 机器人依赖电脑端 WorkBuddy 运行，关机则无法响应」。
- 没有自建中转服务：如果 WorkBuddy 自建中转，就不需要用户先创建 bot，也不会提供「手动填 AppID/AppSecret」的并列选项。

### 4.3 一个关键约束

WorkBuddy 文档只支持**私聊 + 群内 @**，且明确要求关闭「获取群内全部消息」。这与 QQ 侧「未认证/个人认证机器人」的能力边界一致，也解释了为什么它的扫码入口不需要用户配置 intents。

---

## 五、对我们复刻的建议

### 5.1 可行路线：照搬 `/lite/*`（唯一现实选项）

四条独立实现（AstrBot / hermes-agent / dsh-qq-notify / dsh-qqbot-lite）协议完全一致，且腾讯官方 CLI 与官方 WorkBuddy 落地页都在用，说明稳定性足够。整套流程不到 150 行 Node 代码：

```js
// 1) 建任务：key 只留在本地
const key = crypto.randomBytes(32);
const { data: { task_id } } = await post('https://q.qq.com/lite/create_bind_task', { key: key.toString('base64') });
// 2) 渲染二维码（qrcode 包）
const url = `https://q.qq.com/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(task_id)}&_wv=2`;
// 3) 轮询
const { data } = await post('https://q.qq.com/lite/poll_bind_result', { task_id });
if (data.status === 2) return { appid: data.bot_appid, secret: decryptSecret(data.bot_encrypt_secret, key.toString('base64')) };
if (data.status === 3) throw new Error('二维码已过期');
```

工程参数建议（对齐 AstrBot / hermes）：轮询 2s（`login_registration.py:13`、hermes `constants.py:26`）；单次 HTTP 超时 10s（`login_registration.py:14`、hermes `constants.py:27`）；总超时 600s（hermes `onboard.py:84`）；过期自动重建任务最多 3 次（hermes `onboard.py:80,113-119`）；轮询异常时 sleep 2s 后继续，不中断（hermes `onboard.py:108-110`）。

### 5.2 风险点（按严重程度）

1. **反爬拦截**：`q.qq.com` 有 JS 挑战页。`dsh-qq-notify` 的做法是「先 `GET https://q.qq.com/` 预取 cookie（cookie jar），并带浏览器 User-Agent，再调绑定 API」。纯 Node `fetch` 不带 UA 可能被 403 —— 建议默认带一个常见 UA，并保留「失败提示用户手动去 q.qq.com 复制 AppID/AppSecret」的兜底入口。
2. **接口未公开**：字段名（`bot_encrypt_secret` / `bot_appid` / `user_openid`）、状态码语义、`retcode` 约定都可能变。**不要把它做成唯一登入路径**，UI 上必须并列「手动填 AppID/AppSecret」。
3. **用户必须先有 bot**：扫码不能凭空创建（WorkBuddy 文档明确「扫码连接已创建的机器人」）。引导文案要写清「请先到 q.qq.com 创建机器人（个人主体可建 5 个）」，否则用户扫码会看到空列表。
4. **AppSecret 二次查看会重置**：`q.qq.com` 官方提示。所以扫码拿到的 secret 要立刻落库/加密存储，别指望用户回去再查。
5. **IP 白名单**：新机器人默认启用，正式环境调 OpenAPI/连 WS 前必须把服务器出口 IP 加进去（沙箱不受限）。这是扫码之后最容易踩的坑。
6. **Markdown 权限（已更新）**：2026/04/23 起单聊/群聊自定义 markdown 对**所有机器人开放**，无需申请；仅频道场景需内邀。实现时仍建议保留「markdown 失败 → 纯文本」降级（AstrBot 的 `_send_with_markdown_fallback` 是可抄的样板），因为内容超限、空内容、频道场景都会触发失败。
7. **不要把 key 发给服务端之外的任何地方**：密钥只用于本地解密；日志里不要打印 `bind_key` 和 `bot_encrypt_secret`。

### 5.3 建议的对外 API（给 hapi_connector 用）

```
POST /qqbot/bind/start  → { task_id, qrcode_url, interval: 2 }
POST /qqbot/bind/poll   → { status: 'pending'|'created'|'expired'|'error', appid?, secret? }
```

服务端持有 `task_id → bind_key` 的短期（10 分钟）内存映射，**不要**像 AstrBot 那样把 `bind_key` 下发给前端（它是因为 dashboard 无状态才这么做的，我们没这个约束）。

---

## 六、参考索引

| 类型 | 来源 |
| --- | --- |
| 【第三方】 | `E:/myrepo/参考/AstrBot/astrbot/core/platform/sources/qqofficial/login_registration.py`（全文 273 行）、`.../dashboard/services/platform_service.py:200-233`、`tests/test_qqofficial_login_registration.py:19-111` |
| 【第三方】 | `E:/myrepo/参考/hermes-agent/plugins/platforms/qqbot/{constants.py,onboard.py,crypto.py}` |
| 【第三方】 | https://github.com/tencent-connect/openclaw-qqbot （腾讯官方插件，向导内扫码绑定） |
| 【第三方】 | https://github.com/sq8161/dsh-qq-notify （含反爬 cookie/UA 说明）、https://dshmp.com/en/plugins/dsh-qqbot-lite （Node 零依赖复现） |
| 【官方】 | https://bot.qq.com/wiki/ （注册/认证/创建/沙箱/IP 白名单/Agent 接入）、https://bot.qq.com/agent-qqbot/ |
| 【官方】 | https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/markdown.html 、.../autogen/api/v2_users_user_openid_messages.post.html |
| 【官方】 | https://www.codebuddy.cn/docs/workbuddy/QQ-Guide 、https://cloud.tencent.com.cn/document/product/1003/134442 、https://q.qq.com/setup/ |
| 【推测】 | 二维码指向的 H5 内部行为、`/lite/*` 的归属与生命周期 |
