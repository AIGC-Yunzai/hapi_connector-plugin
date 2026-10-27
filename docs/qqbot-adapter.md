# QQ 官方机器人适配器

把 QQ 开放平台的官方机器人接进 Yunzai，作为与 OneBot 账号并列的一等账号。语义对齐 AstrBot 的 `qqofficial` 适配器（见 `docs/adr/0001-align-with-astrbot.md`）。

适配器 `id/name/path` 均为 `QQBot`，由 `index.js` 在顶层注册到 `Bot.adapter`。

## 一、添加一个机器人

### 方式 A：扫码（推荐）

```
#hapi qqbot login
```

机器人会发来一张二维码，用手机 QQ 扫码，确认后 AppID 与 AppSecret 会自动落盘并立即连接。

扫码走的是 QQ 开放平台的门户接口（`q.qq.com/lite/create_bind_task` → 轮询 `/lite/poll_bind_result`），凭证用本地生成的 AES-256 密钥加密回传，全程不经明文。这是一条**官方在用、但未写进公开开发者文档**的通道，接口失效时用方式 B 兜底。

### 方式 B：手填凭证

先在 [q.qq.com](https://q.qq.com) 创建机器人，复制 AppID 与 AppSecret：

```
#hapi qqbot login 102030405 xxxxxxxxxxxxxxxxxxxx
```

> AppSecret 二次查看会强制重置，创建后请立刻保存。

## 二、命令

| 命令 | 说明 |
| --- | --- |
| `#hapi qqbot login` | 扫码添加机器人 |
| `#hapi qqbot login <AppID> <AppSecret>` | 手动添加 |
| `#hapi qqbot list` | 列出全部机器人及在线状态 |
| `#hapi qqbot status <AppID>` | 连接状态、最近入站时间、最近错误 |
| `#hapi qqbot logout <AppID>` | 退出登录，保留凭证但不再连接 |
| `#hapi qqbot remove <AppID>` | 删除，抹掉本地凭证 |
| `#hapi qqbot markdown <AppID> on\|off` | 切换普通文本的发送通道 |

全部命令仅主人可用。`remove` 只清本地——要彻底解除绑定，还需到 q.qq.com 删除该机器人应用。

## 三、消息能力

收到的消息会被规范成 Yunzai 的标准事件：

| QQ 事件 | 事件名 | user_id 取值 |
| --- | --- | --- |
| `GROUP_AT_MESSAGE_CREATE` | `message.group.normal` | `author.member_openid` |
| `GROUP_MESSAGE_CREATE` | `message.group.normal` | `author.member_openid` |
| `C2C_MESSAGE_CREATE` | `message.private.normal` | `author.user_openid` |
| `AT_MESSAGE_CREATE` | `message.group.guild` | `author.id` |
| `DIRECT_MESSAGE_CREATE` | `message.private.normal` | `author.id` |

`group_id` 对群聊是 `group_openid`，对频道是 `guild_id-channel_id`（沿用 OneBot 的 `pickGroup` 约定，`pickGroup('GU-1-C-1')` 能还原出频道）；`self_id` 是 AppID，不是 QQ 号。这些都是字符串，别当数字处理。

**不要预置 `msg`**：云崽的 `loader.dealEvent` 会把 `message` 里的 text 段再拼一遍进 `e.msg`。预置之后 `#设置主人` 会变成 `#设置主人#设置主人`，`^#设置主人$` 这类带锚点的规则全部失配，现象就是「连接正常、入站也有记录，但发什么机器人都没反应」。文本只放在 `message` 段里，`e.msg` 交给云崽自己拼。

发送侧：

- 普通文本默认走 **markdown**（`msg_type=2`）。平台拒绝时按 AstrBot 的顺序降级：先摘掉 `msg_id` 改主动发送，再退回 `content` 纯文本。
- `segment.markdown({ content })` 无论账号开关如何都走 markdown。
- 一条消息里出现多个媒体会被拆成多次请求——QQ 一条消息只能带一个富媒体。
- 群聊/私聊的图片、语音、视频、文件走 `/v2/{users|groups}/{openid}/files` 上传，再以 `msg_type=7` 发出。
- 频道与频道私信没有这条通道，改用 guild 接口的内联字段：URL 走 `image`，本地/`base64://` 走 `file_image`。**只支持图片**，发别的会抛错而不是静默丢消息。
- 引用回复用 `message_scene.ext` 里本条消息的 `msg_idx`（`REFIDX_` 形态）当 `message_reference.message_id`，不能用 `message.id`（`ROBOT1.0_` 形态）。机器人自己发过的消息要引用，得用发送响应里的 `ext_info.ref_idx`。
- **合并转发段没有原生对应**：收到 `node` 段时把各节点正文按顺序拍平成文本（节点之间空行分隔），不会静默丢弃。图片节点记为 `[图片]`。这是兜底——任何插件往官方机器人发合并转发都不会「没有反应」。

### 引用回复

| 方向 | 能力 |
| --- | --- |
| 收到引用（`message_type=103`） | 被引正文从 `msg_elements[0].content` 取，作者昵称从 `msg_elements[0].author` 取，索引优先用 `message_scene.ext` 的 `ref_msg_idx`，其次元素自身的 `msg_idx`。三者一起塞进 `reply` 段（云崽的 reply 段没有昵称字段，这里额外挂 `name`）。 |
| 插件读引用 | `e.reply_id` 是被引消息的 `REFIDX`；`e.getReply()` / `getChatHistory()` 官方不提供，`extractQuotedText` 直接认 reply 段里的内联正文，把 `> ##### 昵称：\n> ---\n> 正文` 拼进提示词。 |
| 发引用 | `segment.reply('REFIDX_...')` 直接生效；`e.reply(msg, true)`（云崽的「引用本条」）也能生效——`replyId` 是 `ROBOT1.0_` 形态时落回本条消息的 `msg_idx`。 |
| 引用机器人自己发过的消息 | 发送成功时把响应里的 `id` 与 `ext_info.ref_idx` 记进进程内的发送索引（上限 500 条，写满后淘汰最早记入的那条），之后 `segment.reply(<那条消息的 message_id>)` 就能引用上去。`sendTo` 的返回值也带 `refIdx`，调用方可直接拿它当 `REFIDX` 用。索引不落盘，重启后这类引用退化为「引用本条」或「不引用」。 |
| 频道 | 频道接口的引用参数就是被引消息的 `id` 本身（官方 Python SDK 示例为 `Reference(message_id=message.id)` + `post_message(channel_id=…)`），没有 `REFIDX` 这套，因此显式 id 原样使用。频道事件不带 `message_scene`，所以没有「引用本条」的默认值。 |
| 默认行为 | 被动回复窗口内的每条回复都会带上 `message_reference` 指向触发那条消息，即**自动引用**（不额外限 300 秒，被动窗口本身就是群 5 分钟 / 私聊 60 分钟）。主动推送没有窗口，因此不引用。 |

## 四、已知限制

- **主动触达有频控**：未认证机器人 30 条/分钟、群维度 20 条/分钟；群里每天每群最多 1000 条。被动回复窗口群聊 5 分钟 / 最多 5 条，私聊 60 分钟 / 最多 4 条。
- **群消息**：只能收到 @ 机器人的消息，除非在手机 QQ 的机器人设置里开启「获取群内全部消息」。开启后官方提示可能影响 @ 消息接收，自行权衡。
- **频道**：富媒体只支持图片（`image` / `file_image`），语音、视频、文件会被拒绝并抛错；markdown 在频道场景需要内邀。
- **频道被动回复**：频道不参与被动回复预算，一律主动发送，因此频道回复不受 5 分钟窗口保护。
- **语音**：不做 silk 转码，直接上传原始音频，部分格式可能被拒。
- **大文件**：超过 10MB 的分片上传尚未实现，当前会走单次上传并可能失败。
- **按钮与交互回调**：未实现（AstrBot 同样未实现）。

## 五、实现结构

```
adapter/
  QQBotOfficial.js       适配器与 Bot 对象、事件规范化、发送编排
  qqbot/
    constants.js         URL、opcode、intents、错误串
    api.js               token 与 REST（含 401 重试、上传、ACK）
    gateway.js           WebSocket：Hello/Identify/Resume/心跳/重连
    passive.js           msg_id + msg_seq 预算
    message.js           消息段 ↔ 平台 payload
    onboard.js           扫码绑定与二维码渲染
    store.js             账号表（config/config/qqbot.yaml）
components/QQBotAdmin.js  #hapi qqbot 子命令（仅主人）
```

连接保活有三条互相独立的看门狗，不能合并成一个定时器：

- **建连超时（20s）**：只在 `open` 之前有效，`open` 成功必须立刻清除。它衡量的是「多久连不上」，不是「这条连接能活多久」——混在一起就会变成每 20 秒主动掐断一条健康的连接，日志表现为固定的 20 秒一次「连接断开（timeout 连接网关超时）」。
- **握手超时（30s）**：`open` 之后到 `READY` / `RESUMED` 之间有效，防止连上了却永远等不到握手。
- **心跳回执**：心跳发出后连续两个周期没收到 `HEARTBEAT_ACK` 就判定 TCP 已假死，主动断开重连。只看 `readyState === OPEN` 不够——假死时状态照样是「在线」，但一条消息都收不到。

另有一条 3 秒的 close 兜底：主动关闭时若对端不回 close 帧，直接 `terminate`，避免连接挂着永远不触发 `close` 事件。

重连退避只由 `stop()` 提前唤醒，socket 的 `close` 事件绝不能顺手清掉退避定时器，否则退避形同虚设（变成 0.5 秒一次的密集重连）。

账号表存在 `config/config/qqbot.yaml`，与 hapi 的 `state.json` 同目录，已在 `.gitignore` 覆盖范围内。

三种会话的目标 ID 各不一样，`pickGroup` / `pickFriend` 负责还原：

| 会话 | `group_id` | 发送端点 |
| --- | --- | --- |
| 群聊 | `group_openid` | `POST /v2/groups/{group_openid}/messages` |
| 频道 | `guild_id-channel_id` | `POST /channels/{channel_id}/messages` |
| C2C 私聊 | 无 | `POST /v2/users/{user_openid}/messages` |
| 频道私信 | 无 | `POST /dms/{guild_id}/messages` |

频道私信的入站事件只带 `author.id`，而发送要 `guild_id`，适配器在内存里维护 `dmTargets`（user_id → guild_id）做换算，超过 1000 条按插入顺序淘汰。

## 六、测试

```bash
npm test
```

`tests/qqbot.*.test.js` 覆盖：token 缓存与 401 重发、被动回复预算（群 5 次/私聊 4 次）、消息段拆块、markdown 降级顺序、引用 ID 提取、扫码解密与轮询状态机、入站去重与事件规范化、网关看门狗（建连/握手/心跳回执）与重连退避。
