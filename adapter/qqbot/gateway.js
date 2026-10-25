import { EventEmitter } from 'node:events'

import {
  OP,
  FATAL_CLOSE_CODES,
  SESSION_INVALID_CLOSE_CODES,
  RECONNECT_BACKOFF_MS,
  RATE_LIMIT_RECONNECT_MS,
} from './constants.js'

const CONNECT_TIMEOUT_MS = 20_000
const QUICK_DISCONNECT_MS = 5_000
const MAX_QUICK_DISCONNECTS = 3
const OPEN = 1

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
 */
export class QQBotGateway extends EventEmitter {
  constructor({ api, intents, ua, maxAttempts = 100 } = {}) {
    super()
    this.api = api
    this.intents = intents
    this.ua = ua
    this.maxAttempts = maxAttempts

    this.ws = null
    this.running = false
    this.sessionId = ''
    this.lastSeq = null
    this.heartbeatMs = 30_000
    this.heartbeatTimer = null
    this.reconnectTimer = null
    this.sleepResolve = null
    this.attempts = 0
    this.quickDisconnects = 0
    this.connectedAt = 0
    this.forceDelay = 0
    this.wsImpl = null
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
    this.#clearTimers()
    const ws = this.ws
    if (!ws) return
    await new Promise(resolve => {
      const done = () => resolve()
      setTimeout(done, 1_500)
      try {
        if (typeof ws.once === 'function') ws.once('close', done)
        ws.close(1000, 'bye')
      } catch {
        done()
      }
    })
    this.ws = null
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
    const idx = Math.min(Math.max(this.attempts - 1, 0), RECONNECT_BACKOFF_MS.length - 1)
    return RECONNECT_BACKOFF_MS[idx]
  }

  #sleep(ms) {
    return new Promise(resolve => {
      this.sleepResolve = resolve
      this.reconnectTimer = setTimeout(() => {
        this.sleepResolve = null
        resolve()
      }, ms)
    })
  }

  #clearTimers() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.heartbeatTimer = null
    this.reconnectTimer = null
    if (this.sleepResolve) {
      this.sleepResolve()
      this.sleepResolve = null
    }
  }

  async #connectOnce() {
    this.wsImpl ||= await resolveWebSocket()
    const { Ctor, native } = this.wsImpl
    const url = await this.api.getGatewayUrl()
    const socket = native ? new Ctor(url) : new Ctor(url, { headers: { 'User-Agent': this.ua } })
    this.ws = socket
    this.forceDelay = 0

    let opened = false
    let settled = false

    await new Promise((resolve, reject) => {
      const settle = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.#clearTimers()
        fn(value)
      }

      const timer = setTimeout(() => {
        terminate(socket)
        settle(reject, Object.assign(new Error('连接网关超时'), { code: 'timeout' }))
      }, CONNECT_TIMEOUT_MS)

      attach(socket, {
        open: () => {
          opened = true
          this.connectedAt = Date.now()
        },
        message: raw => {
          let payload
          try {
            payload = JSON.parse(raw)
          } catch {
            logger.warn('[qqbot] 无法解析的网关帧')
            return
          }
          this.#handle(payload)
        },
        error: err => {
          if (!opened) settle(reject, Object.assign(err || new Error('网关错误'), { code: 'ws_error' }))
          else logger.warn(`[qqbot] 网关异常：${err?.message || err}`)
        },
        close: (code, reason) => {
          this.#clearTimers()
          this.ws = null

          const duration = this.connectedAt ? Date.now() - this.connectedAt : 0
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

          if (opened) settle(resolve, { code, reason })
          else settle(reject, Object.assign(new Error(`网关连接被关闭 [${code}]`), { code }))
        },
      })
    })
  }

  #handle(payload) {
    const { op, d, s, t } = payload
    if (typeof s === 'number' && (this.lastSeq === null || s > this.lastSeq)) this.lastSeq = s

    switch (op) {
      case OP.HELLO: {
        const interval = Number(d?.heartbeat_interval) || 30_000
        this.heartbeatMs = Math.max(5_000, Math.floor(interval * 0.8))
        this.#startHeartbeat()
        void this.#authenticate()
        return
      }
      case OP.HEARTBEAT_ACK:
        return
      case OP.RECONNECT:
        this.#close(4900, 'server requested reconnect')
        return
      case OP.INVALID_SESSION:
        if (!d) {
          this.sessionId = ''
          this.lastSeq = null
        }
        this.#close(4901, 'invalid session')
        return
      case OP.DISPATCH: {
        if (t === 'READY') {
          this.sessionId = String(d?.session_id || '')
          this.attempts = 0
          this.emit('ready', this.sessionId)
        } else if (t === 'RESUMED') {
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
    this.heartbeatTimer = setInterval(() => {
      this.#send({ op: OP.HEARTBEAT, d: this.lastSeq })
    }, this.heartbeatMs)
  }

  #close(code, reason) {
    const socket = this.ws
    if (!socket) return
    try {
      socket.close(code, reason)
    } catch {
      terminate(socket)
    }
  }
}
