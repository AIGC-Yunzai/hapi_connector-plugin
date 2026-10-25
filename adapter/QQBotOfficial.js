import fs from 'node:fs'

import { QQBotApi, QQBotApiError } from './qqbot/api.js'
import { QQBotGateway } from './qqbot/gateway.js'
import { PassiveReplyTracker } from './qqbot/passive.js'
import { accountStore } from './qqbot/store.js'
import {
  segmentsToChunks,
  buildTextPayload,
  buildMediaPayload,
  eventToSegments,
  extractRefIdx,
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
      logger.mark('[qqbot] 还没有机器人账号，使用 #hapi qqbot login 扫码添加')
    }
    for (const account of accounts) {
      if (!account.enabled) continue
      this.login(account.appid).catch(err => logger.error(`[qqbot] 账号 ${account.appid} 登录失败：${err.message}`))
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
      logger.mark(`[qqbot] ${id} 已连接`)
    })

    gateway.on('resumed', () => {
      entry.ready = true
      logger.info(`[qqbot] ${id} 已恢复会话`)
    })

    gateway.on('dispatch', (t, d) => {
      try {
        this.dispatch(entry, t, d)
      } catch (err) {
        logger.error(`[qqbot] ${id} 处理 ${t} 失败：${err.message}`)
      }
    })

    gateway.on('offline', (code, reason) => {
      entry.ready = false
      entry.lastError = `${code} ${reason}`.trim()
      logger.warn(`[qqbot] ${id} 连接断开（${entry.lastError}），将自动重连`)
    })

    gateway.on('fatal', (code, message) => {
      entry.ready = false
      entry.lastError = `${code}: ${message}`
      logger.error(`[qqbot] ${id} 不可恢复：${message}`)
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
    const contact = {
      ...chat,
      self_id: entry.appid,
      get user_id() {
        return chat.id
      },
      get group_id() {
        return groupId
      },
      sendMsg: msg => self.sendTo(entry, chat, msg),
      sendFile: (file, name) => self.sendTo(entry, chat, { type: 'file', file, name }),
      getInfo: async () => ({ user_id: chat.id, group_id: groupId }),
      getSimpleInfo: async () => ({ user_id: chat.id }),
      getAvatarUrl: () => '',
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
    // Yunzai 侧统一按 { message_id } 取返回值，平台原始字段是 id
    if (last && typeof last === 'object') return { ...last, message_id: last.id ?? last.message_id ?? '' }
    return last || { message_id: '' }
  }

  async #sendChunk(entry, chat, chunk) {
    const passive = entry.tracker.take(chat)
    const messageId = passive?.messageId || ''
    const msgSeq = passive?.msgSeq
    const allowSeq = chat.scope !== 'channel'
    // 引用目标优先取调用方给的 REFIDX_，否则回退到本条消息自身（由 tracker 记录）
    const refIdx = chunk.replyId?.startsWith('REFIDX_') ? chunk.replyId : passive?.refIdx || ''

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
   * 403/404/429 这类不降级，直接抛。
   */
  async #sendWithFallback(entry, chat, payload, plainText) {
    try {
      return await this.#callSend(entry, chat, payload)
    } catch (err) {
      if (!(err instanceof QQBotApiError)) throw err

      if (payload.msg_id) {
        const fallback = { ...payload }
        delete fallback.msg_id
        delete fallback.msg_seq
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

  #callSend(entry, chat, payload) {
    const { api } = entry
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

  dispatch(entry, t, d) {
    const kind = INBOUND[t]
    if (!kind) return
    // 还没挂上 Bot 对象时派发出去，插件拿不到 e.reply，会直接炸
    if (!entry.bot) return

    const messageId = String(d?.id || '')
    if (!messageId || this.#isDuplicate(entry, messageId)) return

    entry.lastInboundAt = Date.now()

    const scope = kind
    const chat = resolveChat(scope, d)
    if (!chat.id) return

    const refIdx = extractRefIdx(d)
    entry.tracker.remember(chat, { messageId, refIdx })

    const userId = resolveUserId(scope, d)
    if (scope === 'dm' && userId) this.#rememberDmTarget(entry, userId, chat.id)

    const { segments, plain } = eventToSegments(d, { botId: entry.appid, stripMention: scope === 'group' })

    const data = {
      post_type: 'message',
      message_type: scope === 'group' || scope === 'channel' ? 'group' : 'private',
      sub_type: scope === 'channel' ? 'guild' : 'normal',
      message_id: messageId,
      user_id: userId,
      group_id: resolveGroupId(scope, chat),
      self_id: entry.appid,
      isGroup: scope === 'group' || scope === 'channel',
      isPrivate: scope === 'c2c' || scope === 'dm',
      message: segments,
      raw_message: plain,
      msg: plain,
      sender: { user_id: userId, nickname: d.author?.username || '', card: d.author?.username || '' },
      time: Math.floor(Number(d.timestamp || Date.now() / 1000)),
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
