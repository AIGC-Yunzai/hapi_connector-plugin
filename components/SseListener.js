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
  formatPlanMarkdown,
  messageRole,
  sessionEventRetryText,
  SIMPLE_HIDDEN_EVENT_TYPES,
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
  constructor(client, sessions, notify, stateStore = null) {
    this.client = client
    this.sessions = sessions
    this.notify = notify
    this.stateStore = stateStore
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
    this.remindTimer = null
    this.remindCounts = new Map()
    this.generation = 0
  }

  start(config) {
    this.config = config
    this.startRemindTimer(config)
    if (this.running) return
    this.generation += 1
    this.running = true
    this.loop(this.generation)
  }

  stop() {
    this.generation += 1
    this.running = false
    this.stopRemindTimer()
    this.abortController?.abort()
    this.abortController = null
  }

  restart(config) {
    this.stop()
    this.hibernated = false
    this.connFailCount = 0
    this.connError = ''
    this.start(config)
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

  async loop(generation = this.generation) {
    let backoff = 1000
    while (this.running && generation === this.generation) {
      try {
        this.abortController = new AbortController()
        const res = await this.client.subscribeEvents({ signal: this.abortController.signal })
        this.connFailCount = 0
        this.connError = ''
        backoff = 1000
        logger.mark(`[hapi-connector] SSE 连接成功: ${this.config?.hapi_endpoint || ''}`)
        await this.readStream(res, generation)
      } catch (err) {
        if (!this.running || generation !== this.generation || err.name === 'AbortError') return
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

  async readStream(res, generation = this.generation) {
    let buf = ''
    for await (const chunk of res.body) {
      if (!this.running || generation !== this.generation) return
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
      this.clearPending(evt.sessionId)
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

    // HAPI hub 的 session-updated 事件里 agentState 可能是版本化包装
    // { version, value }（CLI update-state 广播），也可能是原始对象
    // （refreshSession 全量广播）；统一解包后再取 requests。
    const agentState = unwrapVersioned(data.agentState)
    if (agentState && typeof agentState === 'object') {
      await this.handleRequests(sid, agentState.requests || {})
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
      'effectiveModelReasoningEffort',
      'supportedModelReasoningEfforts',
      'effort',
      'collaborationMode',
      'serviceTier',
    ]) {
      const value = unwrapVersioned(data[key])
      if (value !== undefined) session[key] = value
    }
    // metadata / agentState 同样可能是版本化包装 { version, value }，先解包再合并
    const meta = unwrapVersioned(data.metadata)
    if (meta && typeof meta === 'object') {
      session.metadata = { ...(session.metadata || {}), ...meta }
    }
    const agent = unwrapVersioned(data.agentState)
    if (agent !== undefined) session.agentState = agent
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
      if (!requests[rid]) {
        this.freeIndex(oldReqs[rid].index || 0)
        this.remindCounts.delete(`${sid}:${rid}`)
      }
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

    // Plan proposal 等场景：会话等待审批期间 thinking 一直为 true，
    // notifyMessages 不会触发，plan 消息会一直停留在历史里不推送。
    // 这里在出现新请求时主动把尚未推送的 plan md 独立输出。
    if (newItems.length) await this.notifyPendingPlans(sid)
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

      // detail：显示 thinking，保留系统事件细节
      // simple：可见消息 + thinking（reasoning_max_chars>0 时），隐藏 ready/token-count
      // collapsed：tools 合并为 1 块且仅单行标题，不显示 thinking；隐藏 ready/token-count
      // summary：不显示 thinking，隐藏 ready/token-count，只取最后 N 条
      // reasoning_max_chars=0：所有级别都不显示 thinking
      const outputLevel = this.config?.output_level || 'simple'
      const classified = classifyHapiMessages(newMessages, {
        includeUsers: false,
        reasoningMaxChars: this.config?.reasoning_max_chars,
        collapseActivity: outputLevel === 'collapsed',
      })
        .filter(item => this.shouldOutputClassifiedMessage(item))

      // Plan 独立输出：plan / plan_update 消息不混入会话正文，
      // 单独作为一条合并转发 / 一张 markdown 图片推送。
      const lastPlanSeq = this.sessionStates[sid]?.lastPlanSeq || 0
      const planItems = classified.filter(item => item.kind === 'plan' && (item.seq || 0) > lastPlanSeq)
      const others = classified.filter(item => item.kind !== 'plan')
      const visible = others.map(formatClassifiedMessage).filter(Boolean)

      const generatedImages = collectGeneratedImagesFromMessages(newMessages)

      const count = Number(this.config?.summary_msg_count || 5)
      const picked = outputLevel === 'summary' ? others.slice(-count) : others
      const pickedNodes = picked.map(formatClassifiedMessage).filter(Boolean)
      if (pickedNodes.length) {
        const header = await this.buildSessionHeader(sid)
        const payload = [header, ...pickedNodes]
        const outs = await buildMarkdownOutputs(
          this.config?.markdown_output,
          payload,
          nodesToMarkdown(payload),
          this.config?.markdown_theme,
        )
        for (const out of outs) await this.notify(out, sid)
      }

      if (planItems.length) {
        await this.outputPlanItems(sid, planItems, latestSeq)
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

  /**
   * 独立输出 plan md：适配 markdown_output 三种模式。
   * - text：plan 作为独立合并转发节点
   * - image：plan md 渲染为一张 markdown 图片
   * - both：节点 + 图片
   * 输出后记录 lastPlanSeq，避免同一批 plan 消息被重复推送。
   */
  async outputPlanItems(sid, planItems, latestSeq = 0) {
    const planNodes = planItems.map(formatClassifiedMessage).filter(Boolean)
    if (!planNodes.length) return
    const markdown = formatPlanMarkdown(planItems)
    const outs = await buildMarkdownOutputs(
      this.config?.markdown_output,
      planNodes,
      markdown,
      this.config?.markdown_theme,
    )
    for (const out of outs) await this.notify(out, sid)
    const state = this.sessionStates[sid] || {}
    const maxPlanSeq = Math.max(
      Number(state.lastPlanSeq) || 0,
      Number(latestSeq) || 0,
      ...planItems.map(item => item.seq || 0),
    )
    this.sessionStates[sid] = { ...state, lastPlanSeq: maxPlanSeq }
  }

  /**
   * 主动拉取尚未推送的 plan 消息并独立输出。
   * 用于 Plan proposal 等待审批期间（thinking 一直为 true，notifyMessages 不触发）
   * 以及新请求出现时，确保 QQ 能及时看到 plan md。
   */
  async notifyPendingPlans(sid) {
    if (this.config?.output_level === 'silence') return
    try {
      const messages = await ops.fetchMessages(this.client, sid, 50)
      if (!messages.length) return
      const lastPlanSeq = this.sessionStates[sid]?.lastPlanSeq || 0
      const planItems = classifyHapiMessages(messages, {
        includeUsers: false,
        reasoningMaxChars: this.config?.reasoning_max_chars,
        collapseActivity: this.config?.output_level === 'collapsed',
      })
        .filter(item => this.shouldOutputClassifiedMessage(item))
        .filter(item => item.kind === 'plan' && (item.seq || 0) > lastPlanSeq)
      if (!planItems.length) return
      const latestSeq = Math.max(...messages.map(item => item.seq || 0))
      await this.outputPlanItems(sid, planItems, latestSeq)
    } catch (err) {
      logger.warn(`[hapi-connector] 推送 Plan 消息失败: ${err.message || err}`)
    }
  }

  clearPending(sid) {
    if (!sid) return
    if (this.pending[sid]) {
      for (const req of Object.values(this.pending[sid])) this.freeIndex(req.index || 0)
      delete this.pending[sid]
    }
    for (const key of [...this.remindCounts.keys()]) {
      if (key.startsWith(`${sid}:`)) this.remindCounts.delete(key)
    }
  }

  startRemindTimer(config) {
    this.stopRemindTimer()
    if (config?.remind_pending === false) return
    const intervalSec = Number(config?.remind_interval ?? 180)
    const maxCount = Number(config?.remind_max_count ?? 3)
    if (!Number.isFinite(intervalSec) || intervalSec <= 0) return
    if (!Number.isFinite(maxCount) || maxCount <= 0) return
    this.remindTimer = setInterval(() => {
      this.remindPending().catch(err => logger.warn(`[hapi-connector] 待审批重复提醒失败: ${err?.message || err}`))
    }, intervalSec * 1000)
  }

  stopRemindTimer() {
    if (this.remindTimer) {
      clearInterval(this.remindTimer)
      this.remindTimer = null
    }
  }

  /** 按 remind_interval 周期重复提醒尚未处理的待审批/提问请求（最多 remind_max_count 次） */
  async remindPending() {
    if (!this.running || !this.config) return
    const pending = this.getAllPending()
    const items = []
    for (const [sid, reqs] of Object.entries(pending)) {
      for (const [rid, req] of Object.entries(reqs)) items.push({ sid, rid, req })
    }
    if (!items.length) return
    const maxCount = Number(this.config.remind_max_count ?? 3)
    const total = items.length
    for (const { sid, rid, req } of items) {
      const key = `${sid}:${rid}`
      const count = this.remindCounts.get(key) || 0
      if (count >= maxCount) continue
      this.remindCounts.set(key, count + 1)
      try {
        const nodes = formatRequestNodes(sid, req, total, this.sessions, this.config)
        nodes[0] = `⏰ 重复提醒 ${count + 1}/${maxCount}（回复后停止）\n${nodes[0]}`
        await this.notify(nodes, sid)
      } catch (err) {
        logger.warn(`[hapi-connector] 待审批提醒发送失败: ${err?.message || err}`)
      }
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

  /**
   * thinking 显示规则：
   * - collapsed / summary：不显示
   * - simple / detail：显示（需 reasoning_max_chars > 0）
   * - reasoning_max_chars === 0：所有级别都不显示 thinking
   * simple/collapsed/summary 另隐藏 ready、token-count；detail 保留系统事件。
   */
  shouldOutputClassifiedMessage(item) {
    if (!item) return false
    const outputLevel = this.config?.output_level || 'simple'
    const maxReasoning = Number(this.config?.reasoning_max_chars)
    const showThinking = Number.isFinite(maxReasoning) && maxReasoning > 0

    if (item.kind === 'reasoning') {
      if (outputLevel === 'summary' || outputLevel === 'collapsed') return false
      if (!showThinking) return false
      return outputLevel === 'simple' || outputLevel === 'detail'
    }

    if (outputLevel === 'detail') return true
    if (!['simple', 'collapsed', 'summary'].includes(outputLevel)) return true

    if (item.kind === 'session-event') {
      const eventType = item.event?.type
      if (SIMPLE_HIDDEN_EVENT_TYPES.has(eventType)) return false
    }
    return true
  }

  retryState(sid) {
    let state = this.autoRetry.get(sid)
    if (!state) {
      state = { count: this.readAutoRetryCount(sid), timer: null, resetCountdown: false }
      this.autoRetry.set(sid, state)
    }
    return state
  }

  readAutoRetryCount(sid) {
    try {
      const value = Number(this.stateStore?.getAutoRetryCount?.(sid) || 0)
      if (!Number.isFinite(value) || value <= 0) return 0
      return Math.floor(value)
    } catch (err) {
      logger.warn(`[hapi-connector] 读取自动重试计数失败: ${err.message || err}`)
      return 0
    }
  }

  saveAutoRetryCount(sid, count) {
    try {
      this.stateStore?.setAutoRetryCount?.(sid, count)
    } catch (err) {
      logger.warn(`[hapi-connector] 保存自动重试计数失败: ${err.message || err}`)
    }
  }

  clearAutoRetryCount(sid) {
    try {
      this.stateStore?.clearAutoRetryCount?.(sid)
    } catch (err) {
      logger.warn(`[hapi-connector] 清理自动重试计数失败: ${err.message || err}`)
    }
  }

  resetAutoRetry(sid) {
    if (!sid) return
    const state = this.autoRetry.get(sid)
    if (state?.timer) clearTimeout(state.timer)
    this.autoRetry.delete(sid)
    this.clearAutoRetryCount(sid)
  }

  cancelPendingAutoRetry(sid) {
    const state = this.autoRetry.get(sid)
    if (!state?.timer) return
    clearTimeout(state.timer)
    state.timer = null
    state.resetCountdown = true
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
        this.notify(`自动 continue 重试已达上限 ${max} 次，已停止重试。\n命中报错：${matched}\n${sessionLabel(sid, this.sessions)}`, sid).catch(() => { })
      }
      return
    }

    const attempt = state.count + 1
    const delayMin = Math.round(retryDelayMs(this.config) / 60000)
    logger.mark(`[hapi-connector] 命中报错字符串「${matched}」，将在 ${delayMin} 分钟后自动发送 continue (${attempt}/${max}): ${sid.slice(0, 8)}`)
    if (this.config?.output_level !== 'silence') {
      const prefix = state.resetCountdown
        ? '再次触发 HAPI 报错，重试倒计时已重置'
        : '检测到 HAPI 报错'
      this.notify(`${prefix}，将在 ${delayMin} 分钟后自动发送 continue 重试 (${attempt}/${max})。\n命中报错：${matched}\n${sessionLabel(sid, this.sessions)}`, sid).catch(() => { })
    }
    state.resetCountdown = false

    let timer = null
    timer = setTimeout(() => {
      const latest = this.autoRetry.get(sid)
      if (!latest || latest.timer !== timer) return
      latest.timer = null
      latest.count += 1
      this.saveAutoRetryCount(sid, latest.count)
      this.sendAutoContinue(sid, latest.count, max)
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
      const detail = await ops.fetchSessionRuntimeDetail(this.client, sid)
      this.updateSessionCache(sid, detail)
      return this.sessions.find(item => item.id === sid) || detail
    } catch (err) {
      logger.warn(`[hapi-connector] 获取 session 详情失败: ${err.message || err}`)
      return null
    }
  }
}

/**
 * HAPI hub 的 session-updated 事件载荷存在两种形态：
 * - 原始值（refreshSession 全量广播，例如 agentState = { requests, ... }）
 * - 版本化包装 { version, value }（CLI update-state / update-metadata 等 patch 广播）
 * 这里统一解包，读取方无需关心载荷形态。
 */
function unwrapVersioned(value) {
  if (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, 'value')
    && Object.prototype.hasOwnProperty.call(value, 'version')
  ) {
    return value.value
  }
  return value
}
