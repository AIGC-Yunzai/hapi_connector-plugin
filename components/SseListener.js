import * as ops from './SessionOps.js'
import {
  extractTextPreview,
  formatRequestDetail,
  isQuestionRequest,
  sessionLabel,
} from '../utils/formatters.js'

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
          await this.notify(`SSE 已连续失败 ${this.connFailCount} 次，已进入休眠。\n发送 /hapi list 可重新唤醒。`, '')
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
          logger.debug('[hapi-connector] 忽略无法解析的 SSE 事件', err)
        }
      }
    }
  }

  async handle(evt) {
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

    await this.handleRequests(sid, data.agentState?.requests || {})

    if (wasThinking && !thinking) {
      await this.notifyMessages(sid, oldSeq)
    }
  }

  updateSessionCache(sid, data) {
    let session = this.sessions.find(item => item.id === sid)
    if (!session) {
      session = { id: sid, metadata: {} }
      this.sessions.push(session)
    }
    for (const key of ['active', 'thinking', 'pendingRequestsCount', 'permissionMode', 'modelMode', 'collaborationMode']) {
      if (data[key] !== undefined && data[key] !== null) session[key] = data[key]
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

    for (const [rid, req] of newItems) {
      if (this.config?.auto_approve_enabled && this.inAutoApproveWindow() && !isQuestionRequest(req)) {
        const [ok] = await ops.approvePermission(this.client, sid, rid)
        await this.notify(`[忙时托管审批] ${ok ? '已自动批准' : '自动批准失败'}\n${sessionLabel(sid, this.sessions)}\n${formatRequestDetail(req)}`, sid)
        continue
      }
      const total = Object.values(this.pending).reduce((sum, item) => sum + Object.keys(item).length, 0)
      const lines = [
        `${isQuestionRequest(req) ? '问题请求' : '权限请求'} #${req.index}`,
        sessionLabel(sid, this.sessions),
        formatRequestDetail(req),
        '',
        `当前共 ${total} 个待审批`,
        isQuestionRequest(req) ? `/hapi answer ${req.index} <答案>` : `/hapi allow ${req.index}`,
        '/hapi a 批准全部普通请求',
        '/hapi deny 拒绝',
      ]
      await this.notify(lines.join('\n'), sid)
    }
  }

  async notifyMessages(sid, oldSeq) {
    if (this.config?.output_level === 'silence') return
    try {
      const messages = await ops.fetchMessages(this.client, sid, 50)
      if (!messages.length) return
      const latestSeq = Math.max(...messages.map(item => item.seq || 0))
      this.sessionStates[sid] ||= {}
      this.sessionStates[sid].lastSeq = latestSeq

      const visible = messages
        .filter(item => (item.seq || 0) > oldSeq)
        .filter(item => ['agent', 'assistant'].includes(item.content?.message?.role || item.content?.role))
        .map(item => extractTextPreview(item.content))
        .filter(Boolean)

      const count = Number(this.config?.summary_msg_count || 5)
      const picked = this.config?.output_level === 'summary' ? visible.slice(-count) : visible
      if (picked.length) {
        await this.notify(`${sessionLabel(sid, this.sessions)}\n\n${picked.join('\n\n')}`, sid)
      }
      await this.notify(`会话已完成，等待新的输入\n${sessionLabel(sid, this.sessions)}`, sid)
    } catch (err) {
      logger.debug(`[hapi-connector] 拉取会话消息失败: ${err.message || err}`)
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
}
