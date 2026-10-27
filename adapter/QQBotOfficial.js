import fs from 'node:fs'

import { QQBotApi, QQBotApiError } from './qqbot/api.js'
import { QQBotGateway } from './qqbot/gateway.js'
import { PassiveReplyTracker } from './qqbot/passive.js'
import { RefIndex } from './qqbot/refIndex.js'
import { InfoCache } from './qqbot/infoCache.js'
import { convertVoiceToWav } from './qqbot/voice.js'
import { accountStore } from './qqbot/store.js'
import {
  segmentsToChunks,
  buildTextPayload,
  buildMediaPayload,
  eventToSegments,
  extractRefIdx,
  toUnixSeconds,
} from './qqbot/message.js'
import {
  FILE_TYPE,
  MSG_TYPE,
  MAX_CONTENT_LENGTH,
  MARKDOWN_NOT_ALLOWED_ERROR,
  computeIntents,
  buildUserAgent,
  DEDUP_WINDOW_MS,
  DEDUP_MAX_SIZE,
} from './qqbot/constants.js'

const MEDIA_FILE_TYPE = {
  image: FILE_TYPE.IMAGE,
  record: FILE_TYPE.VOICE,
  video: FILE_TYPE.VIDEO,
  file: FILE_TYPE.FILE,
}

const INBOUND = {
  C2C_MESSAGE_CREATE: 'c2c',
  GROUP_AT_MESSAGE_CREATE: 'group',
  GROUP_MESSAGE_CREATE: 'group',
  AT_MESSAGE_CREATE: 'channel',
  DIRECT_MESSAGE_CREATE: 'dm',
}

/** 日志里的场景名，跟云崽适配器的 `好友消息` / `群消息` 对齐，但官方 bot 没有好友，私聊就叫私聊 */
const SCOPE_LABEL = {
  c2c: '私聊消息',
  group: '群消息',
  channel: '频道消息',
  dm: '频道私信',
}

/**
 * 控制台配色。logger 是 chalk 实例（`lib/config/log.js` 里 `global.logger = chalk`），
 * 测试环境只 stub 了基础方法，这里对缺失的颜色方法做兜底。
 */
function paint(color, text) {
  const fn = logger?.[color]
  return typeof fn === 'function' ? fn(String(text)) : String(text)
}

/** openid 有 32 位，日志里没必要铺满一行 */
function shortId(id) {
  const text = String(id || '')
  return text.length > 8 ? `${text.slice(0, 8)}…` : text
}

/** 统一的 `[qqbot]` 前缀：蓝色标签 + 绿色 AppID */
function tag(appid) {
  const head = paint('blue', '[qqbot]')
  return appid ? `${head} ${paint('green', appid)}` : head
}

/**
 * 入站日志走云崽适配器的形状：`[qqbot][self <= 群, 用户] 群消息：[群名, 昵称] 正文`。
 * 方括号前缀自己拼（`makeLog` 的 id 只能是一段），这样才能在 logUin 前面再挂一个 `[qqbot]`；
 * 第三参传 false 让 makeLog 不重复包一层，级别过滤仍然生效。
 */
function logInbound(level, label, logUin, body) {
  const msg = `${paint('blue', '[qqbot]')}${paint('blue', `[${logUin}]`)} ${paint('cyan', `${label}：`)}${body}`
  const bot = globalThis.Bot
  if (typeof bot?.makeLog === 'function') {
    bot.makeLog(level, msg, false)
    return
  }
  const fn = typeof logger?.[level] === 'function' ? logger[level] : logger.info
  fn(msg)
}

/** 从平台事件里取出「往哪儿回」，scope 决定后面走哪个发送接口 */
function resolveChat(scope, d) {
  if (scope === 'group') return { scope, id: String(d.group_openid || '') }
  if (scope === 'channel') return { scope, id: String(d.channel_id || ''), guildId: String(d.guild_id || '') }
  // 频道私信按频道维度回，guild_id 同时用作目标 ID
  if (scope === 'dm') return { scope, id: String(d.guild_id || ''), guildId: String(d.guild_id || '') }
  return { scope, id: String(d.author?.user_openid || '') }
}

function resolveUserId(scope, d) {
  if (scope === 'group') return String(d.author?.member_openid || '')
  if (scope === 'channel' || scope === 'dm') return String(d.author?.id || '')
  return String(d.author?.user_openid || '')
}

/** 频道沿用 OneBot 的 guild-channel 约定，pickGroup 据此认出这是频道 */
function resolveGroupId(scope, chat) {
  if (scope === 'group') return chat.id
  if (scope === 'channel') return `${chat.guildId || ''}-${chat.id}`
  return undefined
}

/**
 * QQ 官方机器人适配器。
 *
 * 一个 AppID 对应一个 `Bot[appid]`，可与 OneBot 账号并存。
 * 账号的增删改查在 `components/QQBotAdmin.js`（`#hapi qqbot` 子命令），这里只负责连接与收发。
 */
export class QQBotOfficialAdapter {
  id = 'QQBot'
  name = 'QQBot'
  path = 'QQBot'

  constructor({ store = accountStore } = {}) {
    this.store = store
    this.entries = new Map()
  }

  async load() {
    const accounts = this.store.list()
    if (!accounts.length) {
      logger.mark(`${tag('')} 还没有机器人账号，使用 #hapi qqbot login 扫码添加`)
    }
    for (const account of accounts) {
      if (!account.enabled) continue
      this.login(account.appid).catch(err => logger.error(`${tag(account.appid)} 登录失败：${err.message}`))
    }

    const exitHandler = () => {
      for (const entry of this.entries.values()) entry.gateway.stop().catch(() => {})
    }
    globalThis.Bot?.once?.('exit', exitHandler)
  }

  /** 登录：建立连接并注册 Bot 对象。已登录则直接返回 */
  async login(appid) {
    const id = String(appid)
    if (this.entries.has(id)) return this.entries.get(id)

    const account = this.store.get(id)
    if (!account) throw new Error(`未找到 AppID 为 ${id} 的机器人账号`)
    if (!account.secret) throw new Error(`账号 ${id} 缺少 AppSecret`)

    const api = new QQBotApi({ appid: id, secret: account.secret })
    const gateway = new QQBotGateway({ api, intents: computeIntents(account), ua: buildUserAgent() })
    const entry = {
      appid: id,
      account,
      api,
      gateway,
      tracker: new PassiveReplyTracker(),
      refIndex: new RefIndex(),
      infoCache: new InfoCache(),
      dedup: new Map(),
      // 频道私信按 guild 维度发送，但入站只有作者 user_id，这里记一笔 user → guild 的对应
      dmTargets: new Map(),
      bot: null,
      lastInboundAt: 0,
      lastError: '',
      ready: false,
    }
    this.entries.set(id, entry)

    gateway.on('ready', () => {
      entry.ready = true
      entry.lastError = ''
      this.#mountBot(entry)
      logger.mark(`${tag(id)} 已连接`)
    })

    gateway.on('resumed', () => {
      entry.ready = true
      entry.lastError = ''
      // 断线重连走的是 Resume，不会再收到 READY；Bot 对象如果被摘掉过（比如被判 fatal），
      // 这里补挂回来，否则会「连着但永远不会派发消息」。
      if (!entry.bot) this.#mountBot(entry)
      logger.info(`${tag(id)} 已恢复会话`)
    })

    gateway.on('dispatch', (t, d) => {
      this.dispatch(entry, t, d).catch(err => {
        logger.error(`${tag(id)} 处理 ${t} 失败：${err.message}`)
      })
    })

    gateway.on('offline', (code, reason) => {
      entry.ready = false
      entry.lastError = `${code} ${reason}`.trim()
      logger.warn(`${tag(id)} 连接断开（${entry.lastError}），将自动重连`)
    })

    gateway.on('fatal', (code, message) => {
      entry.ready = false
      entry.lastError = `${code}: ${message}`
      logger.error(`${tag(id)} 不可恢复：${message}`)
      this.#unmountBot(entry)
    })

    gateway.start().catch(err => {
      entry.lastError = err.message
      logger.error(`[qqbot] ${id} 网关异常退出：${err.message}`)
    })

    return entry
  }

  /** 退出登录：断开连接并移除 Bot 对象，账号记录保留 */
  async logout(appid) {
    const id = String(appid)
    const entry = this.entries.get(id)
    if (!entry) return false
    await entry.gateway.stop()
    this.#unmountBot(entry)
    this.entries.delete(id)
    logger.mark(`[qqbot] ${id} 已退出登录`)
    return true
  }

  /** 删除：退出登录 + 从账号表里抹掉凭证 */
  async remove(appid) {
    const id = String(appid)
    await this.logout(id)
    return this.store.remove(id)
  }

  /**
   * 改账号配置（markdown 开关、启用状态、备注）。
   * 写库的同时把内存里的 entry.account 换成同一份新对象，
   * 否则发送时读到的还是登录那一刻的旧快照。
   */
  updateAccount(appid, patch) {
    const id = String(appid)
    const previous = this.store.get(id)
    if (!previous) throw new Error(`未找到 AppID 为 ${id} 的机器人账号`)
    const account = this.store.upsert({ ...previous, ...patch, appid: id })
    const entry = this.entries.get(id)
    if (entry) entry.account = account
    return account
  }

  status(appid) {
    const id = String(appid)
    const entry = this.entries.get(id)
    if (!entry) return { appid: id, online: false, ready: false, lastInboundAt: 0, lastError: '' }
    return {
      appid: id,
      online: entry.gateway.connected,
      ready: entry.ready,
      lastInboundAt: entry.lastInboundAt,
      lastError: entry.lastError,
    }
  }

  #mountBot(entry) {
    const { appid } = entry
    const self = this
    const bot = {
      adapter: this,
      uin: appid,
      info: { user_id: appid, nickname: entry.account.remark || `QQBot ${appid}` },
      model: 'QQBot Official ',
      stat: { start_time: Math.floor(Date.now() / 1000), message_received: 0, message_sent: 0 },
      fl: new Map(),
      gl: new Map(),
      gml: new Map(),

      get nickname() {
        return this.info.nickname
      },
      get avatar() {
        return ''
      },

      pickFriend(openid) {
        return self.#pickChat(entry, self.resolveFriendChat(entry, openid))
      },
      pickUser(openid) {
        return this.pickFriend(openid)
      },
      pickGroup(groupId) {
        const raw = String(groupId)
        if (raw.includes('-')) {
          const [guildId, channelId] = raw.split('-')
          return self.#pickChat(entry, { scope: 'channel', id: channelId, guildId })
        }
        return self.#pickChat(entry, { scope: 'group', id: raw })
      },
      pickMember(groupId, userId) {
        return this.pickGroup(groupId).pickMember(userId)
      },

      sendMsg() {
        throw new Error('QQ 官方机器人不支持给自己发消息，请用 pickFriend/pickGroup')
      },
      async getFriendList() {
        return [...this.fl.keys()]
      },
      async getGroupList() {
        return [...this.gl.keys()]
      },
    }
    entry.bot = bot
    if (!globalThis.Bot) return
    globalThis.Bot[appid] = bot
    if (!globalThis.Bot.uin.includes(appid)) globalThis.Bot.uin.push(appid)
    globalThis.Bot.em?.(`connect.${appid}`, { self_id: appid, bot })
  }

  #unmountBot(entry) {
    const { appid } = entry
    const Bot = globalThis.Bot
    if (!Bot) return
    try {
      Bot.em?.('offline', { self_id: appid })
    } catch {}
    delete Bot[appid]
    const index = Bot.uin.indexOf(appid)
    if (index >= 0) Bot.uin.splice(index, 1)
    entry.bot = null
  }

  /**
   * 私聊联系人的目标解析。
   * 频道私信发送要 guild 维度（`/dms/{guild_id}/messages`），而入站事件只给作者 user_id，
   * 所以先查 `dmTargets`，查不到才按普通 C2C 处理。
   */
  resolveFriendChat(entry, openid) {
    const uid = String(openid)
    const dmGuildId = entry.dmTargets?.get(uid)
    if (dmGuildId) return { scope: 'dm', id: dmGuildId, guildId: dmGuildId }
    return { scope: 'c2c', id: uid }
  }

  #pickChat(entry, chat) {
    const self = this
    // 频道联系人对外仍用 guild-channel 形态的 group_id，和入站事件里的 e.group_id 保持一致
    const groupId = chat.scope === 'channel' ? `${chat.guildId || ''}-${chat.id}` : chat.id
    if (!chat.name && entry.infoCache) {
      const key = this.#cacheKey(chat)
      const info = key ? entry.infoCache.peek(key) : null
      const name = info?.group_name || info?.name
      if (name) chat.name = String(name)
    }
    const contact = {
      ...chat,
      // 云崽的 `prepareEvent` 用 group.name / group.group_name 填 e.group_name
      name: chat.name || '',
      group_name: chat.name || '',
      self_id: entry.appid,
      get user_id() {
        return chat.id
      },
      get group_id() {
        return groupId
      },
      sendMsg: msg => self.sendTo(entry, chat, msg),
      sendFile: (file, name) => self.sendTo(entry, chat, { type: 'file', file, name }),
      getInfo: async () => ({
        user_id: chat.id,
        group_id: groupId,
        group_name: chat.name || '',
        member_count: chat.memberCount,
      }),
      getSimpleInfo: async () => ({ user_id: chat.id }),
      getAvatarUrl: () => chat.avatar || '',
    }
    if (chat.scope === 'group') {
      contact.pickMember = memberId => self.#pickChat(entry, { scope: 'c2c', id: String(memberId) })
    }
    if (chat.scope === 'channel') {
      contact.pickMember = memberId => self.#pickChat(entry, { scope: 'c2c', id: String(memberId) })
      contact.channel_id = chat.id
      contact.guild_id = chat.guildId
    }
    return contact
  }

  /**
   * 发送消息。按 AstrBot 的规则拆块：每块最多一个富媒体。
   * 返回 { message_id } 以兼容 Yunzai 的返回值约定。
   */
  async sendTo(entry, chat, msg) {
    const chunks = segmentsToChunks(msg)
    if (!chunks.length) return { message_id: '' }

    let last = null
    for (const chunk of chunks) {
      last = await this.#sendChunk(entry, chat, chunk)
    }
    // Yunzai 侧统一按 { message_id } 取返回值，平台原始字段是 id。
    // refIdx 是这条消息的引用索引，拿到它就能直接引用自己发过的这条。
    if (last && typeof last === 'object') {
      return {
        ...last,
        message_id: last.id ?? last.message_id ?? '',
        refIdx: last.ext_info?.ref_idx || '',
      }
    }
    return last || { message_id: '' }
  }

  /**
   * C2C 流式发送：一帧一帧发，`state=1` 追加、`state=10` 收尾。
   *
   * 和 AstrBot 的 `send_streaming` 对齐：
   * - 只有私聊支持流式，群 / 频道请走普通 `sendTo`；
   * - 收尾帧的正文必须以 `\n` 结束，否则平台会判定失败；
   * - 第一帧（`index=0`）会自动从被动预算里取一次凭据，返回值带上 `messageId`/`msgSeq`，
   *   后续帧把它们传回来即可续写同一条消息，不会重复消耗预算；
   * - 节流、累积、工具中断由调用方负责，这里只发一帧。
   *
   * @returns 平台响应（带 `streamId`、`messageId`、`msgSeq`）
   */
  async sendStream(entry, chat, {
    text = '',
    state = 1,
    streamId = '',
    index = 0,
    messageId = '',
    msgSeq,
    passive,
  } = {}) {
    if (chat.scope !== 'c2c') throw new Error('流式消息只支持私聊')

    let credentials = passive
    if (!messageId && !passive && index === 0 && entry.tracker) {
      credentials = entry.tracker.take(chat)
    }
    const effectiveId = messageId || credentials?.messageId || ''
    const effectiveSeq = msgSeq ?? credentials?.msgSeq

    const content = state === 10 && text && !text.endsWith('\n') ? `${text}\n` : text
    const payload = {
      markdown: { content },
      msg_type: MSG_TYPE.MARKDOWN,
      stream: { state, index, reset: false },
    }
    if (streamId) payload.stream.id = String(streamId)
    if (effectiveId) {
      payload.msg_id = effectiveId
      if (effectiveSeq) payload.msg_seq = effectiveSeq
    }

    const result = await this.#callSend(entry, chat, payload)
    return {
      ...result,
      streamId: result?.id || streamId,
      messageId: effectiveId,
      msgSeq: effectiveSeq,
    }
  }

  /**
   * 出站引用目标。
   * - 没给引用目标就不引用：默认自动引用会把触发消息再显示一遍，
   *   官方 bot 又把它渲染在气泡内部，看起来就是「同一条消息被发了两遍」；
   * - 显式给的 `REFIDX_` 直接用；
   * - 其余显式 id 按 ADR-0004 的顺序查：发送索引 → 本条被动消息；
   * - 频道接口的引用参数就是消息 id 本身，没有 REFIDX 这套。
   */
  #resolveRefIdx(entry, chat, replyId, passive) {
    const explicit = String(replyId || '')
    if (chat.scope === 'channel') return explicit
    if (!explicit) return ''
    if (explicit.startsWith('REFIDX_')) return explicit
    return entry.refIndex.get(explicit) || passive?.refIdx || ''
  }

  async #sendChunk(entry, chat, chunk) {
    const passive = entry.tracker.take(chat)
    const messageId = passive?.messageId || ''
    const msgSeq = passive?.msgSeq
    const allowSeq = chat.scope !== 'channel'
    const refIdx = this.#resolveRefIdx(entry, chat, chunk.replyId, passive)

    if (chunk.media) {
      // 频道与频道私信没有 v2 的上传/msg_type=7 通道，走 guild 接口的内联图片字段
      if (chat.scope === 'channel' || chat.scope === 'dm') {
        return this.#sendGuildMedia(entry, chat, chunk, { messageId, msgSeq, refIdx })
      }
      const { fileInfo } = await this.#upload(entry, chat, chunk.media)
      const payload = buildMediaPayload({
        fileInfo,
        text: chunk.text,
        messageId,
        msgSeq,
        refIdx,
        allowSeq,
      })
      return this.#callSend(entry, chat, payload)
    }

    const markdown = chunk.markdown || entry.account.markdown !== false
    const payload = buildTextPayload(chunk, { messageId, msgSeq, refIdx, markdown, allowSeq })
    return this.#sendWithFallback(entry, chat, payload, chunk.text)
  }

  /**
   * 频道富媒体：guild 接口只认 `image`（URL）与 `file_image`（base64 图片数据），
   * 没有 v2 那套上传 + msg_type=7。与 AstrBot 的 `file_image` 路子一致，且只支持图片。
   */
  async #sendGuildMedia(entry, chat, chunk, { messageId, msgSeq, refIdx }) {
    if (chunk.media.kind !== 'image') {
      throw new Error('频道目前只能发图片，语音/视频/文件请改用群聊或私聊')
    }

    const payload = {}
    if (chunk.text) payload.content = String(chunk.text).slice(0, MAX_CONTENT_LENGTH)
    if (chunk.media.url) {
      payload.image = chunk.media.url
    } else {
      let data = chunk.media.base64 || ''
      if (!data && chunk.media.path) data = fs.readFileSync(chunk.media.path).toString('base64')
      if (!data) throw new Error('频道图片需要 http(s) URL 或可读的本地文件')
      payload.file_image = data
    }
    if (messageId) payload.msg_id = messageId
    if (messageId && msgSeq) payload.msg_seq = msgSeq
    if (refIdx) payload.message_reference = { message_id: refIdx }

    return this.#callSend(entry, chat, payload)
  }

  /**
   * AstrBot 的降级顺序：先摘掉 msg_id 改主动发送，再在「不允许发送原生 markdown」时降为纯文本。
   *
   * 5xx / 超时 / 429 / 403 不降级：
   * - 5xx 与超时可能已经送达，重发就是两条一样的消息；
   * - 429 重发只会继续被限流；
   * - 403 是权限问题，换成主动发送也发不出去。
   */
  async #sendWithFallback(entry, chat, payload, plainText) {
    try {
      return await this.#callSend(entry, chat, payload)
    } catch (err) {
      if (!(err instanceof QQBotApiError)) throw err

      const noFallback = !err.status || err.status >= 500 || err.status === 429 || err.status === 403
      if (payload.msg_id && !noFallback) {
        const fallback = { ...payload }
        delete fallback.msg_id
        delete fallback.msg_seq
        // 主动消息没有被动回复窗口，带引用会被平台拒绝
        delete fallback.message_reference
        try {
          const result = await this.#callSend(entry, chat, fallback)
          logger.info(`[qqbot] ${entry.appid} 被动回复失败，已改用主动发送`)
          return result
        } catch (retryErr) {
          if (!(retryErr instanceof QQBotApiError)) throw retryErr
          err = retryErr
          payload = fallback
        }
      }

      const message = String(err.message || '')
      const markdownRejected = message.includes(MARKDOWN_NOT_ALLOWED_ERROR) || (err.status === 400 && /markdown/i.test(message))
      if (!markdownRejected || !payload.markdown || !plainText) throw err

      logger.warn(`[qqbot] ${entry.appid} markdown 被拒，降级为纯文本`)
      const fallback = { ...payload, content: plainText, msg_type: MSG_TYPE.TEXT }
      delete fallback.markdown
      return this.#callSend(entry, chat, fallback)
    }
  }

  async #callSend(entry, chat, payload) {
    // 出站留一行：重复发送时能直接看出是「发了两次」还是「一次发了双份内容」
    const text = String(payload.markdown?.content ?? payload.content ?? '')
    logger.info(
      `${tag(entry.appid)} 发送 ${chat.scope} ${shortId(chat.id)} len=${text.length}` +
      ` msg_id=${payload.msg_id || '-'} seq=${payload.msg_seq ?? '-'}`,
    )
    const result = await this.#dispatchSend(entry.api, chat, payload)
    // 发送响应里的 ext_info.ref_idx 是这条消息的引用索引，
    // 记下来才能让「引用机器人自己发过的消息」找得到它。
    if (result?.id && result?.ext_info?.ref_idx) {
      entry.refIndex.remember(result.id, result.ext_info.ref_idx)
    }
    return result
  }

  #dispatchSend(api, chat, payload) {
    if (chat.scope === 'group') return api.sendGroup(chat.id, payload)
    if (chat.scope === 'channel') {
      // 频道走 guild 接口，不认 v2 的 msg_type。频道也不参与被动回复预算，
      // 虽然当前不会带 msg_seq，仍一并摘掉防止以后开预算时漏改这里。
      const body = { ...payload }
      delete body.msg_type
      delete body.msg_seq
      return api.sendGuildChannel(chat.id, body)
    }
    if (chat.scope === 'dm') {
      // 频道私信走 /dms/{guild_id}/messages，需要 guildId。
      // 与 AstrBot 一致：只摘 msg_type，msg_id / msg_seq 保留，被动回复仍然生效。
      const body = { ...payload }
      delete body.msg_type
      return api.request('POST', `/dms/${encodeURIComponent(chat.guildId || chat.id)}/messages`, { json: body })
    }
    return api.sendC2C(chat.id, payload)
  }

  async #upload(entry, chat, media) {
    const scope = chat.scope === 'group' ? 'group' : 'c2c'
    const fileType = MEDIA_FILE_TYPE[media.kind] || FILE_TYPE.FILE

    let fileData = media.base64 || ''
    if (!fileData && media.path) fileData = fs.readFileSync(media.path).toString('base64')
    const uploaded = await entry.api.uploadMedia({
      scope,
      targetId: chat.id,
      fileType,
      url: media.url,
      fileData: fileData || undefined,
      fileName: media.name,
    })
    return uploaded
  }

  /** 群 / 频道信息缓存的 key，入站与 pickGroup 共用一套 */
  #cacheKey(chat) {
    if (chat.scope === 'group') return `group:${chat.id}`
    if (chat.scope === 'channel') return `channel:${chat.id}`
    return ''
  }

  #applyGuild(chat, guild) {
    chat.avatar = String(guild.icon || '')
    chat.ownerId = String(guild.owner_id || '')
    const count = Number(guild.member_count)
    if (Number.isFinite(count)) chat.memberCount = count
  }

  /**
   * 补全会话元数据：群名 / 频道名 / 成员数。
   * 只有「当前消息要用到的名字」才阻塞等待；guild 头像/人数是锦上添花，
   * 后台补进缓存，不拖慢首条消息的派发。
   */
  async #enrichChat(entry, chat, d) {
    const fromEvent = String(d.group_name || d.channel_name || '').trim()
    if (fromEvent) chat.name = fromEvent

    if (chat.scope === 'group') {
      if (!chat.name) {
        const info = await entry.infoCache.get(this.#cacheKey(chat), async () => {
          const data = await entry.api.getGroupInfo(chat.id)
          // 没拿到群名按失败处理，5 分钟后再试，别把空结果缓存一小时
          return data?.group_name ? data : null
        })
        if (info) {
          chat.name = String(info.group_name || '').trim()
          const count = Number(info.group_member_num ?? info.member_count)
          if (Number.isFinite(count)) chat.memberCount = count
        }
      }
      return
    }

    if (chat.scope === 'channel') {
      if (!chat.name) {
        const channel = await entry.infoCache.get(this.#cacheKey(chat), async () => {
          const data = await entry.api.getChannel(chat.id)
          return data?.name ? data : null
        })
        if (channel) chat.name = String(channel.name || '').trim()
      }
      if (chat.guildId) {
        const key = `guild:${chat.guildId}`
        const cached = entry.infoCache.peek(key)
        if (cached) {
          this.#applyGuild(chat, cached)
        } else {
          // 不 await：guild 信息只影响头像/人数，不能让它再拖 2 秒
          entry.infoCache.get(key, () => entry.api.getGuildInfo(chat.guildId))
            .then(guild => { if (guild) this.#applyGuild(chat, guild) })
            .catch(() => {})
        }
      }
      return
    }

    if (!chat.name && d.author?.username) chat.name = String(d.author.username)
  }

  /**
   * 入站语音尽量转 wav；没有 ffmpeg 或转失败就保留原 URL。
   * 转换成功只替换 `file`（本地 wav），`url` 仍是平台下发的绝对地址——
   * 按 url 取音频的插件不受影响，按 file 取文件的插件拿到 wav。
   */
  async #prepareVoice(segments) {
    for (const seg of segments) {
      if (seg.type !== 'record' || !seg.url) continue
      const wav = await convertVoiceToWav(seg.url, { timeoutMs: 5000 })
      if (wav) seg.file = wav
    }
  }

  async dispatch(entry, t, d) {
    const kind = INBOUND[t]
    if (!kind) return
    // 还没挂上 Bot 对象时派发出去，插件拿不到 e.reply，会直接炸。
    // READY 只在首次连接来一次，这里按需补挂，避免「连着但永远收不到消息」。
    if (!entry.bot) this.#mountBot(entry)
    if (!entry.bot) {
      logger.warn(`[qqbot] ${entry.appid} 收到 ${t} 但 Bot 对象不可用，已丢弃`)
      return
    }

    const messageId = String(d?.id || '')
    if (!messageId || this.#isDuplicate(entry, messageId)) return

    entry.lastInboundAt = Date.now()

    const scope = kind
    const chat = resolveChat(scope, d)
    if (!chat.id) return

    // 被动回复凭据要在改 async 之前记好：后续查群名会 await，
    // 连发两条时不能让后一条覆盖前一条的 msg_id / msg_seq 顺序。
    const refIdx = extractRefIdx(d)
    entry.tracker.remember(chat, { messageId, refIdx })

    const userId = resolveUserId(scope, d)
    if (scope === 'dm' && userId) this.#rememberDmTarget(entry, userId, chat.id)

    if (entry.infoCache) await this.#enrichChat(entry, chat, d)

    // 群 / 频道 @ 消息里的 @ 标记用的是机器人的 openid，不一定是 AppID；
    // 事件里带了 mentions 就以 is_you 的 id 为准，和 AstrBot 的取法一致。
    // 频道事件 AstrBot 直接取 mentions[0].id，这里作为 is_you 缺失时的兜底。
    const mention = (d.mentions || []).find(item => item?.is_you)
    const channelMention = scope === 'channel' ? d.mentions?.[0]?.id : ''
    const mentionId = mention?.id || channelMention
    const isAtEvent = t === 'GROUP_AT_MESSAGE_CREATE' || t === 'AT_MESSAGE_CREATE'
    const { segments, plain } = eventToSegments(d, {
      botId: mentionId ? String(mentionId) : entry.appid,
      stripMention: scope === 'group' || scope === 'channel',
      // @ 事件本身就以「被 @」为前提，mentions 缺失也要补 at 段，
      // 否则 onlyReplyAt=1 的群会因为 e.atBot 为 false 直接不响应
      mentionSelf: isAtEvent || Boolean(mention),
      mentionName: mention?.username || '',
      selfId: entry.appid,
    })
    await this.#prepareVoice(segments)

    // 入站日志对齐云崽适配器的形状：`[self <= 群, 用户] 群消息：[群名, 昵称] 正文`
    const text = String(plain || '').replace(/\s+/g, ' ')
    const preview = text ? `${text.slice(0, 80)}${text.length > 80 ? '…' : ''}` : `[${segments.map(item => item.type).join(',') || '空'}]`
    const nickname = d.author?.username || shortId(userId)
    const inGroup = scope === 'group' || scope === 'channel'
    // 方括号里放 id，正文方括号里放名字，和云崽适配器一致
    const logUin = inGroup
      ? `${entry.appid} <= ${shortId(chat.id)}, ${shortId(userId)}`
      : `${entry.appid} <= ${shortId(userId)}`
    const from = inGroup ? `[${chat.name || shortId(chat.id)}, ${nickname}]` : `[${nickname}]`
    logInbound('info', SCOPE_LABEL[scope] || t, logUin, `${from} ${preview}`)

    // 剥不掉的 @ 标记会让 `^#指令$` 整条失配，且现象是「毫无反应」，先把可疑内容打到日志里
    if (/^[ \t]*<(?:qqbot-at-user|<@!?)/i.test(plain)) {
      logger.warn(`${tag(entry.appid)} 入站文本以 @ 标记开头，按 AppID 剥不掉：${plain.slice(0, 60)}`)
    }

    const data = {
      post_type: 'message',
      message_type: scope === 'group' || scope === 'channel' ? 'group' : 'private',
      sub_type: scope === 'channel' ? 'guild' : 'normal',
      message_id: messageId,
      user_id: userId,
      group_id: resolveGroupId(scope, chat),
      group_name: chat.name || undefined,
      self_id: entry.appid,
      isGroup: scope === 'group' || scope === 'channel',
      isPrivate: scope === 'c2c' || scope === 'dm',
      message: segments,
      raw_message: plain,
      sender: { user_id: userId, nickname: d.author?.username || '', card: d.author?.username || '' },
      time: toUnixSeconds(d.timestamp),
      raw: d,
      bot: entry.bot,
    }
    if (scope === 'channel') data.channel_id = chat.id
    if (scope === 'channel' && chat.guildId) data.guild_id = chat.guildId

    try {
      globalThis.Bot?.em?.(`message.${data.message_type}.${data.sub_type}`, data)
    } catch (err) {
      logger.error(`[qqbot] ${entry.appid} 派发事件失败：${err.message}`)
    }
  }

  #rememberDmTarget(entry, userId, guildId) {
    const map = entry.dmTargets
    if (!map) return
    map.delete(userId)
    map.set(userId, guildId)
    // 私信用户没有上限，超出后按插入顺序淘汰最旧的
    if (map.size > DEDUP_MAX_SIZE) map.delete(map.keys().next().value)
  }

  #isDuplicate(entry, messageId) {
    const now = Date.now()
    if (entry.dedup.has(messageId)) return true
    entry.dedup.set(messageId, now)
    if (entry.dedup.size > DEDUP_MAX_SIZE) {
      for (const [key, at] of entry.dedup) {
        if (now - at > DEDUP_WINDOW_MS) entry.dedup.delete(key)
        if (entry.dedup.size <= DEDUP_MAX_SIZE / 2) break
      }
    }
    return false
  }
}

export const qqbotAdapter = new QQBotOfficialAdapter()

export default QQBotOfficialAdapter
