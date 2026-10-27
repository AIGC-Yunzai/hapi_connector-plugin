import {
  API_BASE,
  TOKEN_URL,
  GATEWAY_PATH,
  DEFAULT_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MS,
  TOKEN_REFRESH_AHEAD_MS,
  buildUserAgent,
} from './constants.js'

export class QQBotApiError extends Error {
  constructor(message, { status = 0, code = 0, path = '', body = null } = {}) {
    super(message)
    this.name = 'QQBotApiError'
    this.status = status
    this.code = code
    this.path = path
    this.body = body
  }
}

function pickMessage(body) {
  if (!body) return ''
  if (typeof body === 'string') return body
  return body.message || body.msg || body.err_msg || JSON.stringify(body)
}

const RETRY_DELAYS = [500, 1500]

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 只有 5xx 与网络/超时才重试；4xx 重试没有意义 */
function isRetryable(err) {
  if (!(err instanceof QQBotApiError)) return false
  return !err.status || err.status >= 500
}

/**
 * QQ 官方机器人 HTTP 客户端。
 * 一个实例对应一个机器人账号，token 在实例内缓存并在过期前 60s 刷新。
 */
export class QQBotApi {
  constructor({ appid, secret, fetchImpl = globalThis.fetch, ua = buildUserAgent(), proxyUrl = '' }) {
    if (!appid || !secret) throw new Error('QQBotApi 需要 appid 与 secret')
    this.appid = String(appid)
    this.secret = String(secret)
    this.fetch = fetchImpl
    this.ua = ua
    this.proxyUrl = proxyUrl
    this.token = ''
    this.expiresAt = 0
    this.authenticating = null
  }

  async getAccessToken(force = false) {
    if (!force && this.token && Date.now() < this.expiresAt - TOKEN_REFRESH_AHEAD_MS) return this.token
    // 单飞：并发请求只换一次 token
    this.authenticating ||= (async () => {
      const res = await this.fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: this.appid, clientSecret: this.secret }),
      })
      const text = await res.text()
      let body = null
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
      if (!res.ok) {
        throw new QQBotApiError(`获取 access_token 失败 [${res.status}]: ${pickMessage(body)}`, {
          status: res.status,
          path: TOKEN_URL,
          body,
        })
      }
      const token = body?.access_token
      if (!token) throw new QQBotApiError('获取 access_token 失败：响应缺少 access_token', { path: TOKEN_URL, body })
      const expiresIn = Number(body.expires_in) || 7200
      this.token = token
      this.expiresAt = Date.now() + expiresIn * 1000
      return token
    })().finally(() => {
      this.authenticating = null
    })
    return this.authenticating
  }

  invalidateToken() {
    this.token = ''
    this.expiresAt = 0
  }

  /**
   * 发请求。
   *
   * `retries` 只给「重试安全」的调用用：GET 元数据、素材上传。发送消息永远不传——
   * 5xx / 超时可能已经送达，重发就是两条一样的消息（去重交给上层）。
   */
  async request(method, path, { json, query, timeout = DEFAULT_TIMEOUT_MS, retryAuth = true, retries = 0 } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#requestOnce(method, path, { json, query, timeout, retryAuth })
      } catch (err) {
        if (attempt >= retries || !isRetryable(err)) throw err
        // 500ms / 1.5s：目前最多两次重试，第三档不会用到
        await sleep(RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)])
      }
    }
  }

  async #requestOnce(method, path, { json, query, timeout, retryAuth }) {
    const url = new URL(`${API_BASE}${path}`)
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
    }

    const send = async () => {
      const headers = {
        Authorization: `QQBot ${await this.getAccessToken()}`,
        'User-Agent': this.ua,
      }
      if (json !== undefined) headers['Content-Type'] = 'application/json'
      return this.fetch(url, {
        method,
        headers,
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: AbortSignal.timeout(timeout),
      })
    }

    let res
    try {
      res = await send()
      if (res.status === 401 && retryAuth) {
        this.invalidateToken()
        res = await send()
      }
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new QQBotApiError(`QQ 接口超时 [${path}]`, { path })
      }
      throw new QQBotApiError(`QQ 接口请求失败 [${path}]: ${err?.message || err}`, { path })
    }

    const text = await res.text()
    let body = null
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    }

    if (!res.ok) {
      throw new QQBotApiError(`QQ 接口错误 [${res.status}] ${path}: ${pickMessage(body)}`, {
        status: res.status,
        code: Number(body?.code) || 0,
        path,
        body,
      })
    }
    return body ?? {}
  }

  async getGatewayUrl() {
    const body = await this.request('GET', GATEWAY_PATH, { retryAuth: true, retries: 2 })
    const url = body?.url
    if (!url) throw new QQBotApiError('获取网关地址失败：响应缺少 url', { path: GATEWAY_PATH, body })
    return url
  }

  /** 群信息：群名、成员数。事件里不一定带群名，缺的时候查这个 */
  getGroupInfo(groupOpenid) {
    return this.request('GET', `/v2/groups/${encodeURIComponent(groupOpenid)}/info`, { timeout: 2000 })
  }

  /** 子频道信息：频道名 */
  getChannel(channelId) {
    return this.request('GET', `/channels/${encodeURIComponent(channelId)}`, { timeout: 2000 })
  }

  /** 频道所属 guild：头像、创建者、成员数 */
  getGuildInfo(guildId) {
    return this.request('GET', `/guilds/${encodeURIComponent(guildId)}`, { timeout: 2000 })
  }

  /** 私聊：/v2/users/{openid}/messages */
  sendC2C(openid, payload) {
    return this.request('POST', `/v2/users/${encodeURIComponent(openid)}/messages`, { json: payload })
  }

  /** 群聊：/v2/groups/{group_openid}/messages */
  sendGroup(groupOpenid, payload) {
    return this.request('POST', `/v2/groups/${encodeURIComponent(groupOpenid)}/messages`, { json: payload })
  }

  /** 频道文本：/channels/{channel_id}/messages（无 msg_type / 无 msg_seq） */
  sendGuildChannel(channelId, payload) {
    return this.request('POST', `/channels/${encodeURIComponent(channelId)}/messages`, { json: payload })
  }

  /**
   * 上传素材。scope 决定落在 users 还是 groups 路径下。
   * url 与 fileData 二选一；fileData 为 base64（可带 data: 前缀，需自行剥离）。
   */
  async uploadMedia({ scope, targetId, fileType, url, fileData, fileName }) {
    const kind = scope === 'group' ? 'groups' : 'users'
    const payload = { file_type: fileType, srv_send_msg: false }
    if (url) payload.url = url
    else if (fileData) payload.file_data = fileData
    else throw new Error('uploadMedia 需要 url 或 fileData')
    if (fileType === 4 && fileName) payload.file_name = fileName

    const body = await this.request('POST', `/v2/${kind}/${encodeURIComponent(targetId)}/files`, {
      json: payload,
      timeout: UPLOAD_TIMEOUT_MS,
      // 上传不是发消息，重试不会产生重复消息；大文件超时后重来一次比直接失败好
      retries: 2,
    })
    const fileInfo = body?.file_info || body?.data?.file_info
    if (!fileInfo) throw new QQBotApiError('上传素材失败：响应缺少 file_info', { body })
    return { fileInfo, fileUuid: body?.file_uuid || body?.data?.file_uuid || '', ttl: body?.ttl ?? body?.data?.ttl ?? 0 }
  }

  /** 按钮点击必须尽快 ACK，否则客户端一直转圈 */
  ackInteraction(interactionId) {
    return this.request('PUT', `/interactions/${encodeURIComponent(interactionId)}`, { json: { code: 0 } })
  }
}
