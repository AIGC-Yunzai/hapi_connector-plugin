import { PASSIVE_LIMITS } from './constants.js'

/**
 * 被动回复预算管理器。
 *
 * QQ 的规则（官方文档）：
 * - 群聊：被动消息 5 分钟内有效，同一条入站消息最多回 5 条
 * - 单聊：被动消息 60 分钟内有效，同一条入站消息最多回 4 条
 * - 相同的 msg_id + msg_seq 重复发送会失败
 *
 * 所以每条入站消息需要记住「还能回几条」，并给每次回复分配一个严格递增的 seq。
 * 预算耗尽或窗口过期后返回 null，调用方改为主动发送。
 */
export class PassiveReplyTracker {
  constructor({ limits = PASSIVE_LIMITS, now = () => Date.now() } = {}) {
    this.limits = limits
    this.now = now
    this.chats = new Map()
  }

  static keyOf(chat = {}) {
    const scope = chat.scope || (chat.groupId ? 'group' : chat.channelId ? 'channel' : 'c2c')
    const id = String(chat.id ?? chat.groupId ?? chat.channelId ?? chat.openid ?? chat.userId ?? '')
    return `${scope}:${id}`
  }

  /** 收到入站消息时调用，刷新该会话的被动回复凭据 */
  remember(chat, { messageId, refIdx = '' } = {}) {
    if (!messageId) return
    const scope = chat.scope || (chat.groupId ? 'group' : chat.channelId ? 'channel' : 'c2c')
    const limit = this.limits[scope]
    const key = PassiveReplyTracker.keyOf(chat)
    // 没有会话 id 就不记：否则不同群会共用 `group:` 这个键，串用彼此的 msg_id
    if (!limit || key.endsWith(':')) return
    this.chats.set(key, {
      scope,
      messageId: String(messageId),
      refIdx: String(refIdx || ''),
      count: 0,
      expiresAt: this.now() + limit.windowMs,
      updatedAt: this.now(),
    })
  }

  /**
   * 取一次被动回复配额。
   * @returns {{messageId: string, msgSeq: number, refIdx: string}|null} 无可用配额时为 null
   */
  take(chat) {
    const key = PassiveReplyTracker.keyOf(chat)
    const entry = this.chats.get(key)
    if (!entry) return null
    const limit = this.limits[entry.scope]
    if (!limit) return null
    if (this.now() > entry.expiresAt) {
      this.chats.delete(key)
      return null
    }
    if (entry.count >= limit.maxReplies) return null
    entry.count += 1
    return { messageId: entry.messageId, msgSeq: entry.count, refIdx: entry.refIdx }
  }

  /** 主动发送或降级之后，判断是否还值得继续挂 msg_id */
  remaining(chat) {
    const entry = this.chats.get(PassiveReplyTracker.keyOf(chat))
    if (!entry || this.now() > entry.expiresAt) return 0
    return Math.max(0, this.limits[entry.scope].maxReplies - entry.count)
  }

  forget(chat) {
    this.chats.delete(PassiveReplyTracker.keyOf(chat))
  }

  /** 清理过期条目，避免长期运行后无限增长 */
  prune() {
    const now = this.now()
    for (const [key, entry] of this.chats) {
      if (now > entry.expiresAt) this.chats.delete(key)
    }
  }
}
