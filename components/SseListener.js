import * as ops from './SessionOps.js'
import {
  extractTextPreview,
  formatRequestDetail,
  formatRequestNodes,
  isQuestionRequest,
  sessionLabel,
  sessionLabelWithRuntime,
} from '../utils/formatters.js'
import { buildMarkdownOutputs, nodesToMarkdown } from '../utils/markdownPic.js'
import { collectGeneratedImagesFromMessages, imageSegmentFromBuffer } from '../utils/generatedImages.js'
import {
  formatClassifiedMessage,
  classifyHapiMessages,
  messageRole,
  sessionEventRetryText,
} from '../utils/hapiMessages.js'

function retryDelayMs(config = {}) {
  const minutes = Number(config.retry_delay_minutes ?? 1)
  if (!Number.isFinite(minutes) || minutes <= 0) return 60 * 1000
  return Math.floor(minutes * 60 * 1000)
}

function retryErrorStrings(config = {}) {
  const raw = config.retry_error_strings
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : []
  return values
    .map(item => String(item || '').trim())
    .filter(Boolean)
}

function retryMaxCount(config = {}) {
  const value = Number(config.retry_max_count ?? 10)
  if (!Number.isFinite(value)) return 10
  return Math.max(0, Math.floor(value))
}

export class SseListener {
  constructor(client, sessions, notify) {
    this.client = client
    this.sessions = sessions
    this.notify = notify
    this.pending = {}
    this.sessionStates = {}
    this.freeIndices = new Set()
    this.maxIndex = 0
    this.running = false
    this.abortController = null
    this.connFailCount = 0
    this.connError = ''
    this.hibernated = false
    this.autoRetry = new Map()
  }

  start(config) {
    this.config = config
    if (this.running) return
    this.running = true
    this.loop()
  }

  stop() {
    this.running = false
    this.abortController?.abort()
  }

  wakeUp() {
    if (!this.hibernated) return
    this.hibernated = false
    this.connFailCount = 0
    this.connError = ''
    if (!this.running) {
      this.running = true
      this.loop()
    }
  }

  getAllPending() {
    return structuredClone(this.pending)
  }

  allocateIndex() {
    if (this.freeIndices.size) {
      const idx = Math.min(...this.freeIndices)
      this.freeIndices.delete(idx)
      return idx
    }
    this.maxIndex += 1
    return this.maxIndex
  }

  freeIndex(index) {
    if (index > 0) this.freeIndices.add(index)
  }

  async loop() {
    let backoff = 1000
    while (this.running) {
      try {
        this.abortController = new AbortController()
        const res = await this.client.subscribeEvents({ signal: this.abortController.signal })
        this.connFailCount = 0
        this.connError = ''
        backoff = 1000
        logger.mark(`[hapi-connector] SSE 连接成功: ${this.config?.hapi_endpoint || ''}`)
        await this.readStream(res)
      } catch (err) {
        if (!this.running || err.name === 'AbortError') return
        this.connFailCount += 1
        this.connError = `${err.name || 'Error'}: ${err.message || err}`
        logger.mark(`[hapi-connector] SSE 连接失败(${this.connFailCount}): ${this.connError}`)
        const max = Number(this.config?.max_reconnect_attempts || 0)
        if (max > 0 && this.connFailCount >= max) {
          this.hibernated = true
          this.running = false
          logger.mark(`[hapi-connector] SSE 连续失败 ${this.connFailCount} 次，已进入休眠`)
          await this.notify(`SSE 已连续失败 ${this.connFailCount} 次，已进入休眠。\n发送 #hapi list 可重新唤醒。`, '')
          return
        }
        await new Promise(resolve => setTimeout(resolve, backoff))
        backoff = Math.min(backoff * 2, 60000)
      }
    }
  }

  async readStream(res) {
    let buf = ''
    for await (const chunk of res.body) {
      if (!this.running) return
      buf += Buffer.from(chunk).toString('utf8')
      let idx = buf.indexOf('\n')
      while (idx >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '')
        buf = buf.slice(idx + 1)
        idx = buf.indexOf('\n')
        if (!line.startsWith('data: ')) continue
        try {
          await this.handle(JSON.parse(line.slice(6)))
        } catch (err) {
          logger.warn('[hapi-connector] 忽略无法解析的 SSE 事件', err)
        }
      }
    }
  }

  async handle(evt) {
    if (evt.type === 'message-received') {
      this.handleMessageReceived(evt)
      return
    }
    if (evt.type === 'session-ended' || evt.type === 'session-removed') {
      this.resetAutoRetry(evt.sessionId)
      return
    }
    if (evt.type !== 'session-updated') return
    const sid = evt.sessionId
    const data = evt.data || {}
    if (!sid) return

    this.updateSessionCache(sid, data)
    const old = this.sessionStates[sid] || {}
    let oldSeq = old.lastSeq
    if (oldSeq === undefined) oldSeq = await this.getLatestSeq(sid)

    const thinking = data.thinking ?? old.thinking ?? false
    const wasThinking = old.thinking ?? false
    this.sessionStates[sid] = {
      active: data.active ?? old.active ?? false,
      thinking,
      lastSeq: oldSeq,
    }

    if (data.agentState) {
      await this.handleRequests(sid, data.agentState.requests || {})
    }

    if (!wasThinking && thinking) {
      this.cancelPendingAutoRetry(sid)
    }

    if (wasThinking && !thinking) {
      await this.notifyMessages(sid, oldSeq)
    }
  }

  handleMessageReceived(evt) {
    const sid = evt.sessionId
    if (!sid) return

    const content = evt.message?.content || {}
    const role = messageRole(content)
    if (role !== 'user') return

    const text = (extractTextPreview(content) || '').trim()
    if (text && text !== 'continue') {
      this.resetAutoRetry(sid)
    }
  }

  updateSessionCache(sid, data) {
    let session = this.sessions.find(item => item.id === sid)
    if (!session) {
      session = { id: sid, metadata: {} }
      this.sessions.push(session)
    }
    for (const key of [
      'active',
      'thinking',
      'pendingRequestsCount',
      'permissionMode',
      'modelMode',
      'model',
      'modelReasoningEffort',
      'effort',
      'collaborationMode',
    ]) {
      if (data[key] !== undefined) session[key] = data[key]
    }
    if (data.metadata && typeof data.metadata === 'object') {
      session.metadata = { ...(session.metadata || {}), ...data.metadata }
    }
  }

  async getLatestSeq(sid) {
    try {
      const messages = await ops.fetchMessages(this.client, sid, 1)
      return messages[0]?.seq || 0
    } catch {
      return 0
    }
  }

  async handleRequests(sid, requests) {
    const oldReqs = this.pending[sid] || {}
    for (const rid of Object.keys(oldReqs)) {
      if (!requests[rid]) this.freeIndex(oldReqs[rid].index || 0)
    }

    const newItems = []
    for (const [rid, req] of Object.entries(requests)) {
      if (!oldReqs[rid]) {
        req.index = this.allocateIndex()
        newItems.push([rid, req])
      } else {
        req.index = oldReqs[rid].index
      }
    }

    if (Object.keys(requests).length) this.pending[sid] = requests
    else delete this.pending[sid]

    if (newItems.length && this.config?.more_session_info) await this.refreshSessionDetail(sid)

    for (const [rid, req] of newItems) {
      if (this.config?.auto_approve_enabled && this.inAutoApproveWindow() && !isQuestionRequest(req)) {
        const [ok] = await ops.approvePermission(this.client, sid, rid)
        await this.notify(`[忙时托管审批] ${ok ? '已自动批准' : '自动批准失败'}\n${sessionLabel(sid, this.sessions)}\n${formatRequestDetail(req)}`, sid)
        continue
      }
      const total = Object.values(this.pending).reduce((sum, item) => sum + Object.keys(item).length, 0)
      await this.notify(formatRequestNodes(sid, req, total, this.sessions, this.config), sid)
    }
  }

  async notifyMessages(sid, oldSeq) {
    try {
      const messages = await ops.fetchMessages(this.client, sid, 50)
      if (!messages.length) return
      const latestSeq = Math.max(...messages.map(item => item.seq || 0))
      this.sessionStates[sid] ||= {}
      this.sessionStates[sid].lastSeq = latestSeq

      // 提取可见文本消息、系统事件和 generated-image 消息。
      const newMessages = messages.filter(item => (item.seq || 0) > oldSeq)

      this.handleAutoContinueRetry(sid, newMessages)

      if (this.config?.output_level === 'silence') return

      const visible = classifyHapiMessages(newMessages, { includeUsers: false })
        .filter(item => this.shouldOutputClassifiedMessage(item))
        .map(formatClassifiedMessage)
        .filter(Boolean)

      const generatedImages = collectGeneratedImagesFromMessages(newMessages)

      const count = Number(this.config?.summary_msg_count || 5)
      const picked = this.config?.output_level === 'summary' ? visible.slice(-count) : visible
      if (picked.length) {
        const header = await this.buildSessionHeader(sid)
        const payload = [header, ...picked]
        const outs = await buildMarkdownOutputs(this.config?.markdown_output, payload, nodesToMarkdown(payload))
        for (const out of outs) await this.notify(out, sid)
      }

      // 发送 generated-image 图片（单独发送，不放入 markdown 渲染）
      for (const img of generatedImages) {
        const buffer = await ops.fetchGeneratedImage(this.client, sid, img.imageId)
        if (buffer) {
          await this.notify(imageSegmentFromBuffer(buffer, img), sid)
        } else {
          logger.warn(`[hapi-connector] 无法获取图片: ${img.imageId}`)
        }
      }

      // 仅图片模式下不发「会话已完成」文字，避免图片后又跟一句纯文字提示
      if (this.config?.markdown_output !== 'image') {
        await this.notify(`【会话已完成，等待新的输入】\n${sessionLabel(sid, this.sessions)}`, sid)
      }
    } catch (err) {
      logger.warn(`[hapi-connector] 拉取会话消息失败: ${err.message || err}`)
    }
  }

  handleAutoContinueRetry(sid, messages) {
    if (!messages.length) return

    const text = sessionEventRetryText(messages)
    if (!text) return

    const matched = retryErrorStrings(this.config).find(item => text.includes(item))
    if (!matched) {
      this.resetAutoRetry(sid)
      return
    }

    this.scheduleAutoContinueRetry(sid, matched)
  }

  /** {"type":"ready"} 这个系统消息在 simple/summary 不输出，detail 保留完整事件 */
  shouldOutputClassifiedMessage(item) {
    if (['simple', 'summary'].includes(this.config?.output_level) && item?.kind === 'session-event' && item.event?.type === 'ready') {
      return false
    }
    return true
  }

  retryState(sid) {
    let state = this.autoRetry.get(sid)
    if (!state) {
      state = { count: 0, timer: null }
      this.autoRetry.set(sid, state)
    }
    return state
  }

  resetAutoRetry(sid) {
    if (!sid) return
    const state = this.autoRetry.get(sid)
    if (state?.timer) clearTimeout(state.timer)
    this.autoRetry.delete(sid)
  }

  cancelPendingAutoRetry(sid) {
    const state = this.autoRetry.get(sid)
    if (!state?.timer) return
    clearTimeout(state.timer)
    state.timer = null
    logger.mark(`[hapi-connector] 会话已开始新一轮思考，取消待发送的自动 continue: ${sid.slice(0, 8)}`)
  }

  scheduleAutoContinueRetry(sid, matched) {
    const max = retryMaxCount(this.config)
    if (max <= 0) return

    const state = this.retryState(sid)
    if (state.timer) return

    if (state.count >= max) {
      logger.mark(`[hapi-connector] 自动 continue 重试已达上限 ${max}: ${sid.slice(0, 8)}`)
      if (this.config?.output_level !== 'silence') {
        this.notify(`自动 continue 重试已达上限 ${max} 次，已停止重试。\n命中报错：${matched}\n${sessionLabel(sid, this.sessions)}`, sid).catch(() => {})
      }
      return
    }

    state.count += 1
    const attempt = state.count
    const delayMin = Math.round(retryDelayMs(this.config) / 60000)
    logger.mark(`[hapi-connector] 命中报错字符串「${matched}」，将在 ${delayMin} 分钟后自动发送 continue (${attempt}/${max}): ${sid.slice(0, 8)}`)
    if (this.config?.output_level !== 'silence') {
      this.notify(`检测到 HAPI 报错，将在 ${delayMin} 分钟后自动发送 continue 重试 (${attempt}/${max})。\n命中报错：${matched}\n${sessionLabel(sid, this.sessions)}`, sid).catch(() => {})
    }

    let timer = null
    timer = setTimeout(() => {
      const latest = this.autoRetry.get(sid)
      if (!latest || latest.timer !== timer) return
      latest.timer = null
      this.sendAutoContinue(sid, attempt, max)
    }, retryDelayMs(this.config))
    state.timer = timer
  }

  async sendAutoContinue(sid, attempt, max) {
    if (!this.running) return
    try {
      const [ok, message] = await ops.sendMessageWithDelayYolo(this.client, sid, 'continue', [], {
        delay_yolo_mode: !!this.config?.delay_yolo_mode,
      })
      if (ok) {
        logger.mark(`[hapi-connector] 已自动发送 continue 重试 (${attempt}/${max}): ${sid.slice(0, 8)}`)
      } else {
        logger.warn(`[hapi-connector] 自动发送 continue 失败: ${message}`)
        if (this.config?.output_level !== 'silence') await this.notify(`自动发送 continue 失败：${message}`, sid)
      }
    } catch (err) {
      logger.warn(`[hapi-connector] 自动发送 continue 异常: ${err.message || err}`)
      if (this.config?.output_level !== 'silence') await this.notify(`自动发送 continue 异常：${err.message || err}`, sid)
    }
  }

  inAutoApproveWindow() {
    try {
      const [sh, sm] = String(this.config.auto_approve_start || '23:00').split(':').map(Number)
      const [eh, em] = String(this.config.auto_approve_end || '07:00').split(':').map(Number)
      const now = new Date()
      const minutes = now.getHours() * 60 + now.getMinutes()
      const start = sh * 60 + sm
      const end = eh * 60 + em
      return start <= end ? minutes >= start && minutes <= end : minutes >= start || minutes <= end
    } catch {
      return false
    }
  }

  async buildSessionHeader(sid) {
    if (!this.config?.more_session_info) return sessionLabel(sid, this.sessions)
    const detail = await this.refreshSessionDetail(sid)
    return sessionLabelWithRuntime(detail || sid, detail ? [detail] : this.sessions)
  }

  async refreshSessionDetail(sid) {
    try {
      const detail = await ops.fetchSessionDetail(this.client, sid)
      this.updateSessionCache(sid, detail)
      return detail
    } catch (err) {
      logger.warn(`[hapi-connector] 获取 session 详情失败: ${err.message || err}`)
      return null
    }
  }
}
