# 以 AstrBot 为基准实现，只在 msg_seq 与降级细节上偏离

按 AstrBot 的 `qqofficial` 适配器搬运，语义以它为准：`msg_type` 默认走 markdown、媒体消息降级为 `msg_type=7` 并丢弃 markdown、引用回复用 `REFIDX_`、群与私聊分别用 `member_openid` 与 `user_openid`、markdown 被拒时按「先摘 msg_id、再降 content」的顺序回退。这些都与 AstrBot 逐条对齐，不再按 hermes 写。

故意不同的地方有两处，都写在下面。

## 偏离一：`msg_seq` 用自增，不用随机数

AstrBot 写的是 `payload["msg_seq"] = random.randint(1, 10000)`（`qqofficial_message_event.py:449`），hermes 写的是 `(time ^ random) % 65536`。两边都是随机的，但官方文档明确「`msg_seq` 与 `msg_id` 联合使用，避免相同消息 id 回复重复发送」「相同的 `msg_id + msg_seq` 重复发送会失败」。随机值意味着长会话里迟早碰撞，碰撞的那条回复直接被平台拒掉，而现象是「偶尔少一条消息」，极难排查。

改为每个入站 `msg_id` 维护一个从 1 开始的计数器（`adapter/qqbot/passive.js`），天然不重复。协议上没有上限要求，计数器只增不减即可。

## 偏离二：被动回复失败改主动发送时，连 `msg_seq` 一起摘掉

AstrBot 的降级只 `pop("msg_id")`，把 `msg_seq` 留在 payload 里（`qqofficial_message_event.py:648` 附近）。本实现两个都摘。

`msg_seq` 的定义就是「与 `msg_id` 联合使用」，在没有 `msg_id` 的主动发送里带一个孤立序号，最好的情况是被平台忽略，最差的情况是被判非法参数——那样降级本身也会失败，消息直接丢掉。既然是降级兜底路径，就按「只保留一定能被接受的字段」来写。

频道私信（`/dms/{guild_id}/messages`）不受这条影响：那里只摘 `msg_type`，`msg_id` / `msg_seq` 都保留，被动回复照常生效，与 AstrBot 一致。

## 与 hermes 版本相比消掉的两处偏离

早先按 hermes 实现时记过另外两处偏离，换成 AstrBot 后它们不再成立：

- **引用回复用 `REFIDX_…`**：AstrBot 已经是对的，`_extract_self_ref_idx()` 从 `message_scene.ext` 取 `msg_idx=`，且注释点明 `message.id` 不能直接用。本实现照抄，不算偏离。
- **markdown 默认开启**：AstrBot 的被动回复本来就默认 `msg_type=2`，配置项 `use_markdown` 只影响主动推送。本实现沿用这个默认值。
