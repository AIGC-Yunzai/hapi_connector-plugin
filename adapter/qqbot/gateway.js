import { EventEmitter } from 'node:events'

import {
  OP,
  FATAL_CLOSE_CODES,
  SESSION_INVALID_CLOSE_CODES,
  RECONNECT_BACKOFF_MS,
  RATE_LIMIT_RECONNECT_MS,
} from './constants.js'

/** 建连看门狗：只管「多久连不上」，连接建立后必须立刻清掉 */
const CONNECT_TIMEOUT_MS = 20_000
/** open 之后还要等 HELLO → Identify/Resume → READY，这一段单独设上限 */
const HANDSHAKE_TIMEOUT_MS = 30_000
const QUICK_DISCONNECT_MS = 5_000
const MAX_QUICK_DISCONNECTS = 3
/** 对端不回 close 帧时的兜底时长 */
const CLOSE_FALLBACK_MS = 3_000
const MIN_HEARTBEAT_MS = 5_000
const OPEN = 1

/**
 * 本地主动断开用的关闭码。
 * 4000 在网关错误表里是「未知错误」，既不在 FATAL_CLOSE_CODES（不可恢复），
 * 也不在 SESSION_INVALID_CLOSE_CODES（会连带清 session），适合当本地重连标记；
 * 4900-4913 那张表会清 session，不能拿来做这件事。
 */
const LOCAL_CLOSE = 4000

/**
 * 优先用 ws（可以带 User-Agent），没有就退回 Node 内置 WebSocket。
 * TRSS 的依赖树里 ws 不一定被链接到根 node_modules，所以不能硬依赖。
 */
async function resolveWebSocket() {
  try {
    const mod = await import('ws')
    if (mod?.WebSocket) return { Ctor: mod.WebSocket, native: false }
  } catch {}
  if (globalThis.WebSocket) return { Ctor: globalThis.WebSocket, native: true }
  throw new Error('当前 Node 没有可用的 WebSocket 实现，请升级到 Node 22+ 或安装 ws')
}

/** 把 ws（EventEmitter）与浏览器风格 WebSocket 统一成同一组回调 */
function attach(socket, handlers) {
  if (typeof socket.on === 'function') {
    socket.on('open', handlers.open)
    socket.on('message', data => handlers.message(data.toString()))
    socket.on('error', handlers.error)
    socket.on('close', (code, reason) => handlers.close(code, reason?.toString?.() || ''))
    return
  }
  socket.addEventListener('open', handlers.open)
  socket.addEventListener('message', event => handlers.message(String(event.data)))
  socket.addEventListener('error', handlers.error)
  socket.addEventListener('close', event => handlers.close(event.code, event.reason || ''))
}

function terminate(socket) {
  if (typeof socket.terminate === 'function') socket.terminate()
  else {
    try {
      socket.close()
    } catch {}
  }
}

/**
 * QQ 官方机器人 WebSocket 网关。
 *
 * 事件：ready / resumed / dispatch(t, d) / fatal(code, message) / offline(code, reason)
 *
 * 三条独立的看门狗，别混用：
 * - 建连超时：只在 open 之前有效，open 后立即清除（否则会把活着的连接掐死）
 * - 握手超时：open 之后到 READY/RESUMED 之间有效
 * - 心跳回执：连续两个周期没收到 ACK 就认为 TCP 已假死，主动重连
 */
export class QQBotGateway extends EventEmitter {
  constructor({
    api,
    intents,
    ua,
    maxAttempts = 100,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
    handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
    minHeartbeatMs = MIN_HEARTBEAT_MS,
    backoff = RECONNECT_BACKOFF_MS,
    wsImpl = null,
  } = {}) {
    super()
    this.api = api
    this.intents = intents
    this.ua = ua
    this.maxAttempts = maxAttempts
    this.connectTimeoutMs = connectTimeoutMs
    this.handshakeTimeoutMs = handshakeTimeoutMs
    this.minHeartbeatMs = minHeartbeatMs
    this.backoff = backoff

    this.ws = null
    this.running = false
    this.sessionId = ''
    this.lastSeq = null
    this.heartbeatMs = 30_000
    this.heartbeatTimer = null
    this.connectTimer = null
    this.handshakeTimer = null
    this.reconnectTimer = null
    this.sleepResolve = null
    this.pendingHeartbeats = 0
    this.attempts = 0
    this.quickDisconnects = 0
    this.connectedAt = 0
    this.forceDelay = 0
    this.wsImpl = wsImpl
  }

  get connected() {
    return Boolean(this.running && this.ws && this.ws.readyState === OPEN)
  }

  async start() {
    if (this.running) return
    this.running = true
    await this.#loop()
  }

  async stop() {
    this.running = false
    this.#clearSocketTimers()
    this.#wake()
    const ws = this.ws
    if (!ws) return
    await new Promise(resolve => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      const timer = setTimeout(finish, 1_500)
      timer.unref?.()
      try {
        if (typeof ws.once === 'function') ws.once('close', finish)
        else ws.addEventListener?.('close', finish, { once: true })
        ws.close(1000, 'bye')
      } catch {
        finish()
      }
    })
    if (this.ws === ws) this.ws = null
  }

  async #loop() {
    while (this.running) {
      this.attempts += 1
      if (this.attempts > this.maxAttempts) {
        this.emit('fatal', 'reconnect_exhausted', `连续重连 ${this.maxAttempts} 次仍失败`)
        this.running = false
        return
      }

      try {
        await this.#connectOnce()
        if (!this.running) return
        await this.#sleep(this.#nextBackoff())
      } catch (err) {
        // stop() 期间正在建的连接会以各种方式失败，别再报「连接断开」
        if (!this.running) return
        if (err?.fatal) {
          this.emit('fatal', err.code || 'fatal', err.message)
          this.running = false
          return
        }
        this.emit('offline', err?.code || 0, err?.message || String(err))
        await this.#sleep(this.#nextBackoff())
      }
    }
  }

  #nextBackoff() {
    if (this.forceDelay) {
      const delay = this.forceDelay
      this.forceDelay = 0
      return delay
    }
    const idx = Math.min(Math.max(this.attempts - 1, 0), this.backoff.length - 1)
    return this.backoff[idx]
  }

  #sleep(ms) {
    return new Promise(resolve => {
      this.sleepResolve = resolve
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        this.sleepResolve = null
        resolve()
      }, ms)
    })
  }

  /** 只用于 stop：提前结束退避等待。socket 的 close 事件绝不能调它，否则退避形同虚设 */
  #wake() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    const resolve = this.sleepResolve
    this.sleepResolve = null
    resolve?.()
  }

  /** 只清理「当前这条连接」的定时器，不碰重连退避 */
  #clearSocketTimers() {
    if (this.connectTimer) clearTimeout(this.connectTimer)
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.connectTimer = null
    this.handshakeTimer = null
    this.heartbeatTimer = null
  }

  async #connectOnce() {
    this.wsImpl ||= await resolveWebSocket()
    const { Ctor, native } = this.wsImpl
    const url = await this.api.getGatewayUrl()
    // 取网关地址是异步的，这期间可能已经 stop()（比如 logout）
    if (!this.running) throw Object.assign(new Error('网关已停止'), { code: 'stopped' })
    const socket = native ? new Ctor(url) : new Ctor(url, { headers: { 'User-Agent': this.ua } })
    this.ws = socket
    this.forceDelay = 0

    let opened = false
    let openedAt = 0
    let settled = false

    await new Promise((resolve, reject) => {
      const settle = (fn, value) => {
        if (settled) return
        settled = true
        this.#clearSocketTimers()
        fn(value)
      }

      this.connectTimer = setTimeout(() => {
        terminate(socket)
        settle(reject, Object.assign(new Error('连接网关超时'), { code: 'timeout' }))
      }, this.connectTimeoutMs)

      attach(socket, {
        open: () => {
          // 建连看门狗已经判失败并 settle 过，这条连接视为作废
          if (settled) return
          opened = true
          openedAt = Date.now()
          this.connectedAt = openedAt
          // 连接已建立，建连看门狗必须立刻退场：它衡量的是「连不上」，不是「连接能活多久」
          clearTimeout(this.connectTimer)
          this.connectTimer = null
          this.handshakeTimer = setTimeout(() => {
            logger.warn('[qqbot] 网关握手超时（HELLO/READY 未到达），重新连接')
            this.#close(LOCAL_CLOSE, 'handshake timeout', socket)
          }, this.handshakeTimeoutMs)
        },
        message: raw => {
          let payload
          try {
            payload = JSON.parse(raw)
          } catch {
            logger.warn('[qqbot] 无法解析的网关帧')
            return
          }
          this.#handle(payload, socket)
        },
        error: err => {
          if (!opened) settle(reject, Object.assign(err || new Error('网关错误'), { code: 'ws_error' }))
          else logger.warn(`[qqbot] 网关异常：${err?.message || err}`)
        },
        close: (code, reason) => {
          // 旧连接的 close 可能晚于新连接建立（TCP 拆除比退避还慢），
          // 只有「当前这条」才允许清定时器，否则会把新连接的看门狗全部清掉
          if (this.ws === socket) {
            this.#clearSocketTimers()
            this.pendingHeartbeats = 0
            this.ws = null
          }
          // 这条连接已经被放弃（建连超时 / 握手超时后另起了新连接），close 不再参与判定
          if (settled) return

          const duration = openedAt ? Date.now() - openedAt : 0
          if (opened && duration < QUICK_DISCONNECT_MS) {
            this.quickDisconnects += 1
            if (this.quickDisconnects >= MAX_QUICK_DISCONNECTS) {
              return settle(
                reject,
                Object.assign(new Error('连续快速断连，请检查 AppID/AppSecret 与机器人权限'), {
                  fatal: true,
                  code: 'quick_disconnect',
                }),
              )
            }
          } else if (duration >= QUICK_DISCONNECT_MS) {
            this.quickDisconnects = 0
          }

          const fatalText = FATAL_CLOSE_CODES.get(code)
          if (fatalText) {
            return settle(
              reject,
              Object.assign(new Error(`网关关闭 [${code}] ${fatalText}`), { fatal: true, code: `close_${code}` }),
            )
          }
          if (code === 4004) this.api.invalidateToken()
          if (SESSION_INVALID_CLOSE_CODES.has(code)) {
            this.sessionId = ''
            this.lastSeq = null
          }
          if (code === 4008) {
            logger.warn('[qqbot] 触发限频，60 秒后重连')
            this.forceDelay = RATE_LIMIT_RECONNECT_MS
          }

          if (opened) {
            // 已经连上的连接掉了，也要让上层知道：否则状态面板会一直显示「在线」，
            // 而日志里连一条「连接断开」都没有（重连成功时又只看到「已恢复会话」）
            if (this.running) this.emit('offline', code, reason || 'connection closed')
            settle(resolve, { code, reason })
          } else settle(reject, Object.assign(new Error(`网关连接被关闭 [${code}]`), { code }))
        },
      })
    })
  }

  #handle(payload, socket = this.ws) {
    // 已经被替换掉的旧连接迟到的帧，直接丢弃，避免污染新连接的 seq 与 session
    if (socket !== this.ws) return

    const { op, d, s, t } = payload
    if (typeof s === 'number' && (this.lastSeq === null || s > this.lastSeq)) this.lastSeq = s

    switch (op) {
      case OP.HELLO: {
        const interval = Number(d?.heartbeat_interval) || 30_000
        this.heartbeatMs = Math.max(this.minHeartbeatMs, Math.floor(interval * 0.8))
        this.pendingHeartbeats = 0
        this.#startHeartbeat()
        void this.#authenticate()
        return
      }
      case OP.HEARTBEAT_ACK:
        this.pendingHeartbeats = 0
        return
      case OP.RECONNECT:
        this.#close(LOCAL_CLOSE, 'server requested reconnect', socket)
        return
      case OP.INVALID_SESSION:
        if (!d) {
          this.sessionId = ''
          this.lastSeq = null
        }
        // session 该不该清已经按 d 判断过了，这里只负责断开重连
        this.#close(LOCAL_CLOSE, 'invalid session', socket)
        return
      case OP.DISPATCH: {
        if (t === 'READY') {
          this.#settleHandshake()
          this.sessionId = String(d?.session_id || '')
          this.attempts = 0
          this.emit('ready', this.sessionId)
        } else if (t === 'RESUMED') {
          this.#settleHandshake()
          this.attempts = 0
          this.emit('resumed')
        } else {
          this.emit('dispatch', t, d)
        }
        return
      }
      default:
    }
  }

  /** READY/RESUMED 到了，握手阶段结束 */
  #settleHandshake() {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = null
  }

  async #authenticate() {
    try {
      await this.api.getAccessToken()
    } catch (err) {
      logger.error(`[qqbot] 换 token 失败：${err?.message || err}`)
      this.#close(4004, 'token unavailable')
      return
    }
    if (this.sessionId && this.lastSeq !== null) this.#resume()
    else this.#identify()
  }

  #identify() {
    this.#send({
      op: OP.IDENTIFY,
      d: {
        token: `QQBot ${this.api.token}`,
        intents: this.intents,
        shard: [0, 1],
        properties: { $os: process.platform, $browser: 'yunzai', $device: 'yunzai' },
      },
    })
  }

  #resume() {
    this.#send({
      op: OP.RESUME,
      d: { token: `QQBot ${this.api.token}`, session_id: this.sessionId, seq: this.lastSeq },
    })
  }

  #send(payload) {
    if (this.ws?.readyState !== OPEN) return false
    try {
      this.ws.send(JSON.stringify(payload))
      return true
    } catch (err) {
      logger.warn(`[qqbot] 发送网关帧失败：${err?.message || err}`)
      return false
    }
  }

  #startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => this.#heartbeat(), this.heartbeatMs)
  }

  /**
   * 心跳 + 回执看门狗。
   *
   * 只发心跳不看回执的话，TCP 半开（服务端已经不再推事件，本端却收不到 FIN）
   * 会一直挂在「在线」状态，表现就是「连着但收不到任何消息」——
   * 这里连续两个周期没有 ACK 就主动断开重连。
   */
  #heartbeat() {
    if (!this.connected) return
    if (this.pendingHeartbeats >= 2) {
      logger.warn('[qqbot] 心跳连续两个周期没有回执，判定网关连接假死，主动重连')
      this.#close(LOCAL_CLOSE, 'heartbeat timeout')
      return
    }
    this.pendingHeartbeats += 1
    this.#send({ op: OP.HEARTBEAT, d: this.lastSeq })
  }

  #close(code, reason, socket = this.ws) {
    if (!socket) return
    if (this.ws !== socket) {
      terminate(socket)
      return
    }
    try {
      socket.close(code, reason)
    } catch {
      terminate(socket)
      return
    }
    // 对端不回应 close 帧时兜底，避免连接一直挂着不触发 close 事件
    const timer = setTimeout(() => {
      if (this.ws === socket) terminate(socket)
    }, CLOSE_FALLBACK_MS)
    timer.unref?.()
  }
}
