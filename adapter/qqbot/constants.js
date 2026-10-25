/** QQ 官方机器人协议常量。数值全部来自 hermes-agent / AstrBot 实测，勿随意调整 */
export const API_BASE = 'https://api.sgroup.qq.com'
export const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
export const GATEWAY_PATH = '/gateway'

/** 扫码绑定走的门户域名，可用环境变量覆盖（企业代理/测试环境） */
export const PORTAL_HOST = process.env.QQ_PORTAL_HOST || 'q.qq.com'
export const BIND_CREATE_PATH = '/lite/create_bind_task'
export const BIND_POLL_PATH = '/lite/poll_bind_result'
export const BIND_CONNECT_PATH = '/qqbot/openclaw/connect.html'

/**
 * intents 位掩码：
 * 1<<12 DIRECT_MESSAGE     频道私信
 * 1<<25 GROUP_AND_C2C      群@ / 私聊 / 好友与群增删
 * 1<<26 INTERACTION        按钮回调
 * 1<<30 PUBLIC_GUILD       频道公域 @ 消息
 */
export const INTENT_BITS = {
  GUILD_MESSAGES: 1 << 9,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
  INTERACTION: 1 << 26,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
}

/**
 * 与 AstrBot 对齐：public_guild_messages 恒开，
 * enable_group_c2c 控制 1<<25，enable_guild_direct_message 控制 1<<12。
 * 三者全开时为 1107300352。
 *
 * 账号表存的是 snake_case，直接传 account 也能正确解析。
 */
export function computeIntents(opts = {}) {
  const groupC2C = opts.enableGroupC2C ?? opts.enable_group_c2c ?? true
  const guildDM = opts.enableGuildDirectMessage ?? opts.enable_guild_direct_message ?? true
  let intents = INTENT_BITS.PUBLIC_GUILD_MESSAGES
  if (groupC2C) intents |= INTENT_BITS.GROUP_AND_C2C
  if (guildDM) intents |= INTENT_BITS.DIRECT_MESSAGE
  return intents
}


export const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
}

export const MSG_TYPE = {
  TEXT: 0,
  MARKDOWN: 2,
  INPUT_NOTIFY: 6,
  MEDIA: 7,
}

/** 富媒体文件类型 */
export const FILE_TYPE = {
  IMAGE: 1,
  VIDEO: 2,
  VOICE: 3,
  FILE: 4,
}

/** 被动回复预算：群聊与私聊不同，不能合并成一个常量 */
export const PASSIVE_LIMITS = {
  group: { maxReplies: 5, windowMs: 5 * 60 * 1000 },
  c2c: { maxReplies: 4, windowMs: 60 * 60 * 1000 },
  // 频道私信官方没给单独口径，按单聊的数走。估小了只是提前转主动发送，
  // 估大了平台会拒，再由 #sendWithFallback 摘掉 msg_id 重发，两头都有兜底。
  dm: { maxReplies: 4, windowMs: 60 * 60 * 1000 },
}

export const MAX_CONTENT_LENGTH = 4000

export const TOKEN_REFRESH_AHEAD_MS = 60 * 1000
export const DEFAULT_TIMEOUT_MS = 30 * 1000
export const UPLOAD_TIMEOUT_MS = 120 * 1000

/** 服务端要求重连（保留 session 走 Resume） */
export const SESSION_INVALID_CLOSE_CODES = new Set([4006, 4007, ...Array.from({ length: 14 }, (_, i) => 4900 + i)])

/** 不可恢复，直接停止重连 */
export const FATAL_CLOSE_CODES = new Map([
  [4001, 'invalid opcode'],
  [4002, 'invalid payload'],
  [4010, 'invalid shard'],
  [4011, 'sharding required'],
  [4012, 'invalid api version'],
  [4013, 'invalid intent'],
  [4014, 'intent not authorized'],
  [4914, 'offline/sandbox-only'],
  [4915, 'banned'],
])

export const RECONNECT_BACKOFF_MS = [2000, 5000, 10000, 30000, 60000]
export const RATE_LIMIT_RECONNECT_MS = 60000

/** 去重窗口：同一条入站消息可能因 Resume 重复投递 */
export const DEDUP_WINDOW_MS = 5 * 60 * 1000
export const DEDUP_MAX_SIZE = 1000

/** 引用消息的魔法值：message_type === 103 才带 msg_elements */
export const QUOTED_MESSAGE_TYPE = 103

/** markdown 被平台拒绝时返回的错误串（AstrBot 逐字对齐） */
export const MARKDOWN_NOT_ALLOWED_ERROR = '不允许发送原生 markdown'

/** 出站 @ 的两种写法，入站时都要剥掉 */
export function stripBotMention(content, botId) {
  if (!content || !botId) return content || ''
  const id = String(botId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const markup = `<qqbot-at-user\\s+id="${id}"\\s*/>|<@!?${id}>`
  return String(content).replace(new RegExp(`(?:[ \\t]*(?:${markup})[ \\t]*)+`, 'g'), ' ')
}

/** 出站把 segment.at 还原成平台标记 */
export function atMarkup(id) {
  return `<qqbot-at-user id="${id}" />`
}

export function buildUserAgent() {
  return `QQBotAdapter/1.1.0 (Node/${process.versions.node}; Yunzai/hapi-connector)`
}

