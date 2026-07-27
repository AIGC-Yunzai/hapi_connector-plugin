const AGENT_MESSAGE_PAYLOAD_TYPE = 'codex'

const VISIBLE_SYSTEM_SUBTYPES = new Set([
  'api_error',
  'turn_duration',
  'microcompact_boundary',
  'compact_boundary',
])

/** simple/collapsed/summary 默认隐藏的 session-event 类型（对齐 WebUI 噪音过滤） */
export const SIMPLE_HIDDEN_EVENT_TYPES = new Set(['ready', 'token-count'])

export function messageRole(content) {
  const record = unwrapRoleWrappedRecord(content)
  return record?.role || '?'
}

export function classifyHapiMessage(message) {
  const content = message?.content ?? message
  const record = unwrapRoleWrappedRecord(content)
  if (!record) return null

  const role = record.role
  if (role === 'user') {
    const text = extractPlainText(record.content)
    return text ? buildClassified('user', message, text) : null
  }

  if (role !== 'agent' && role !== 'assistant') return null

  const body = record.content
  if (!isObject(body)) {
    const text = extractPlainText(body)
    return text ? buildClassified('assistant-reply', message, text) : null
  }

  if (body.type === 'output') return classifyClaudeOutput(message, body.data)
  if (body.type === 'event') return classifySessionEvent(message, body.data)
  if (body.type === AGENT_MESSAGE_PAYLOAD_TYPE) return classifyCodexPayload(message, body.data)

  const text = extractPlainText(body)
  return text ? buildClassified('assistant-reply', message, text) : null
}

export function formatClassifiedMessage(item) {
  if (!item?.text) return ''
  // activity 块本身是摘要列表，不再附带 #seq，避免与块内多行标题抢视觉
  if (item.kind === 'activity') return `${item.label}\n${item.text}`
  const seq = item.seq ? ` #${item.seq}` : ''
  return `${item.label}${seq}\n${item.text}`
}

export function classifyHapiMessages(messages, options = {}) {
  const includeUsers = options.includeUsers !== false
  const maxReasoningChars = Number(options.reasoningMaxChars)
  const collapseActivity = Boolean(options.collapseActivity)
  const classified = (Array.isArray(messages) ? messages : [])
    .flatMap(item => {
      const result = classifyHapiMessage(item)
      if (!result) return []
      return Array.isArray(result) ? result : [result]
    })
    .filter(item => item && (includeUsers || item.kind !== 'user'))
    .map(item => truncateReasoningText(item, maxReasoningChars))
  // 与 WebUI 一致：同 callId 的 tool-call 状态更新只保留一条
  const collapsed = collapseToolCallMessages(collapseReasoningMessages(classified))
  // collapsed 推送级别：连续 tool 合并为 1 个 activity 块，块内仅单行标题
  return collapseActivity ? collapseActivityBlocks(collapsed) : collapsed
}

export function formatHapiMessageNodes(messages, options = {}) {
  const nodes = classifyHapiMessages(messages, options)
    .map(formatClassifiedMessage)
    .filter(Boolean)
  if (nodes.length) return nodes
  return Array.isArray(messages) && messages.length ? ['(暂无可显示的消息)'] : ['(暂无消息)']
}

export function sessionEventRetryText(messages) {
  return classifyHapiMessages(messages, { includeUsers: false })
    .filter(item => item.kind === 'session-event' && item.event?.type === 'message')
    .map(item => item.retryText || item.text)
    .filter(Boolean)
    .join('\n')
}

/**
 * 合并同 stream 的 reasoning 增量（WebUI 覆盖式 merge）。
 * - 有 streamId：同 id 只保留最后一条
 * - 无 streamId：连续 reasoning 只保留最后一条（避免流式半截刷屏）
 */
export function collapseReasoningMessages(items) {
  const list = Array.isArray(items) ? items : []
  const out = []
  const streamIndex = new Map()

  for (const item of list) {
    if (item?.kind !== 'reasoning') {
      out.push(item)
      continue
    }

    const streamId = String(item.streamId || '').trim()
    if (streamId) {
      const existing = streamIndex.get(streamId)
      if (existing !== undefined) {
        out[existing] = item
        continue
      }
      streamIndex.set(streamId, out.length)
      out.push(item)
      continue
    }

    const prev = out[out.length - 1]
    if (prev?.kind === 'reasoning' && !String(prev.streamId || '').trim()) {
      out[out.length - 1] = item
      continue
    }
    out.push(item)
  }

  return out
}

const COLLAPSED_TITLE_MAX = 120

/**
 * 把 tool 正文压成单行标题（对齐 WebUI minimal tool card 只露 title）。
 */
export function formatCollapsedToolTitle(text, maxLen = COLLAPSED_TITLE_MAX) {
  const line = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!line) return ''
  const limit = Number(maxLen)
  if (!Number.isFinite(limit) || limit <= 0 || line.length <= limit) return line
  return `${line.slice(0, Math.max(1, limit - 1)).trimEnd()}…`
}

/**
 * 连续 tool-call 合并为 1 个 activity 块（对齐 WebUI tool-group 折叠态）。
 * 块内每条 tool 仅保留单行标题；reasoning 不并入（collapsed/summary 直接不显示 thinking）。
 */
export function collapseActivityBlocks(items) {
  const list = Array.isArray(items) ? items : []
  const out = []
  let toolBuf = []

  const flushTools = () => {
    if (!toolBuf.length) return
    const titles = toolBuf
      .map(item => formatCollapsedToolTitle(item.text))
      .filter(Boolean)
    if (!titles.length) {
      toolBuf = []
      return
    }
    const last = toolBuf[toolBuf.length - 1]
    out.push({
      kind: 'activity',
      label: 'activity',
      seq: Number(last?.seq) || 0,
      text: titles.join('\n'),
      tools: toolBuf.slice(),
      event: { type: 'activity', count: titles.length },
    })
    toolBuf = []
  }

  for (const item of list) {
    if (item?.kind === 'tool-call') {
      toolBuf.push(item)
      continue
    }
    flushTools()
    out.push(item)
  }
  flushTools()
  return out
}

/**
 * 合并同 callId 的 tool-call 状态更新（对齐 WebUI ensureToolBlock）。
 * Grok/ACP 对一次 Execute 常写 pending → pending(补全) → in_progress 多条，
 * 同 callId 只保留最后一条（覆盖式 merge，位置保持首次出现处）。
 */
export function collapseToolCallMessages(items) {
  const list = Array.isArray(items) ? items : []
  const out = []
  const callIndex = new Map()

  for (const item of list) {
    if (item?.kind !== 'tool-call') {
      out.push(item)
      continue
    }

    const callId = String(item.callId || '').trim()
    if (!callId) {
      out.push(item)
      continue
    }

    const existingPos = callIndex.get(callId)
    if (existingPos === undefined) {
      callIndex.set(callId, out.length)
      out.push(item)
      continue
    }

    // 后写覆盖先写（与 WebUI 一致）；若后一条摘要更空则保留先前的正文
    const prev = out[existingPos]
    const next = item
    const prevDetail = toolCallDetail(prev?.text)
    const nextDetail = toolCallDetail(next?.text)
    if (nextDetail || !prevDetail) {
      out[existingPos] = next
    } else {
      out[existingPos] = {
        ...next,
        text: prev.text,
        label: next.label || prev.label,
      }
    }
  }

  return out
}

function toolCallDetail(text) {
  const raw = String(text || '')
  const i = raw.indexOf(':')
  if (i < 0) return ''
  return raw.slice(i + 1).trim()
}

/**
 * 截断 thinking 文本。limit<=0 时不在此丢弃（由输出级别/配置决定是否推送），
 * 仅对 limit>0 做长度限制。
 */
export function truncateReasoningText(item, maxChars) {
  if (!item || item.kind !== 'reasoning') return item
  const limit = Number(maxChars)
  if (!Number.isFinite(limit) || limit <= 0) return item
  const text = String(item.text || '')
  if (text.length <= limit) return item
  return { ...item, text: `${text.slice(0, limit).trimEnd()}…` }
}

function classifyClaudeOutput(message, data) {
  if (!isObject(data) || typeof data.type !== 'string') return null
  if (data.isMeta || data.isCompactSummary) return null
  if (!isClaudeVisibleMessage(data)) return null

  if (data.type === 'assistant') return classifyClaudeAssistant(message, data)

  if (data.type === 'system' && data.subtype === 'api_error') {
    const text = withErrorDetail(formatApiError(data), data.error)
    return buildClassified('api-error', message, text, { event: { type: 'api-error' } })
  }

  if (data.type === 'system' && data.subtype === 'turn_duration') {
    return buildClassified('session-event', message, `Turn: ${formatDuration(Number(data.durationMs) || 0)}`, {
      event: { type: 'turn-duration' },
    })
  }

  if (data.type === 'system' && data.subtype === 'microcompact_boundary') {
    const meta = isObject(data.microcompactMetadata) ? data.microcompactMetadata : {}
    const saved = Number(meta.tokensSaved) || 0
    const formatted = saved >= 1000 ? `${Math.round(saved / 1000)}K` : String(saved)
    return buildClassified('session-event', message, `Context compacted (saved ${formatted} tokens)`, {
      event: { type: 'microcompact' },
    })
  }

  if (data.type === 'system' && data.subtype === 'compact_boundary') {
    return buildClassified('session-event', message, 'Conversation compacted', {
      event: { type: 'compact' },
    })
  }

  if (data.type === 'summary' && typeof data.summary === 'string') {
    return buildClassified('summary', message, data.summary)
  }

  return null
}

function classifyClaudeAssistant(message, data) {
  const body = isObject(data.message) ? data.message : null
  if (!body) return null

  const content = body.content
  if (typeof content === 'string') {
    const text = content.trim()
    return text ? buildClassified('assistant-reply', message, text) : null
  }

  if (!Array.isArray(content)) {
    const text = extractReplyPlainText(content)
    return text ? buildClassified('assistant-reply', message, text) : null
  }

  const thinkingParts = []
  const textParts = []
  const toolParts = []

  for (const block of content) {
    if (!isObject(block)) continue
    const type = String(block.type || '')
    if (type === 'thinking') {
      const thinking = firstString(block.thinking, block.text)
      if (thinking) thinkingParts.push(thinking)
      continue
    }
    if (type === 'text') {
      const text = firstString(block.text)
      if (text) textParts.push(text)
      continue
    }
    if (['tool_use', 'tool-call'].includes(type)) {
      const tool = formatToolCall(block.name, block.input)
      if (tool) {
        toolParts.push({
          text: tool,
          callId: firstString(block.id, block.tool_use_id, block.toolUseId, block.callId),
        })
      }
    }
  }

  const items = []
  if (thinkingParts.length) {
    items.push(buildClassified('reasoning', message, thinkingParts.join('\n'), {
      event: { type: 'reasoning' },
    }))
  }
  for (const tool of toolParts) {
    items.push(buildClassified('tool-call', message, tool.text, {
      callId: tool.callId || undefined,
      event: tool.callId ? { type: 'tool-call', callId: tool.callId } : { type: 'tool-call' },
    }))
  }
  if (textParts.length) {
    items.push(buildClassified('assistant-reply', message, textParts.join('\n')))
  }
  return items.length ? items : null
}

function classifySessionEvent(message, event) {
  if (!isObject(event) || typeof event.type !== 'string') return null
  const kind = event.type === 'api-error'
    ? 'api-error'
    : event.type === 'error'
      ? 'error'
      : 'session-event'
  return buildClassified(kind, message, formatEventText(event), {
    event,
    retryText: event.type === 'message' && typeof event.message === 'string' ? event.message : '',
  })
}

function classifyCodexPayload(message, data) {
  if (!isObject(data) || typeof data.type !== 'string') return null

  if (data.type === 'generated-image') return null

  if (data.type === 'error' && typeof data.message === 'string') {
    return buildClassified('error', message, data.message, { event: { type: 'error', message: data.message } })
  }

  if (data.type === 'task_failed') {
    const detail = firstString(data.error, data.message, data.reason)
    const text = detail ? `Task failed: ${detail}` : 'Task failed'
    return buildClassified('error', message, text, { event: { type: 'error', message: text } })
  }

  if (data.type === 'message' && typeof data.message === 'string') {
    return buildClassified('assistant-reply', message, data.message)
  }

  // Grok/Codex/ACP reasoning 流（WebUI 的 thinking 块）
  if (data.type === 'reasoning' && typeof data.message === 'string') {
    const streamId = firstString(data.id, data.streamId, data.stream_id)
    return buildClassified('reasoning', message, data.message, {
      event: { type: 'reasoning', id: streamId || undefined },
      streamId,
    })
  }

  if (data.type === 'tool-call' && typeof data.callId === 'string') {
    const callId = firstString(data.callId, data.id)
    return buildClassified('tool-call', message, formatToolCall(data.name, data.input), {
      callId,
      event: { type: 'tool-call', callId, status: firstString(data.status) || undefined },
    })
  }

  if (data.type === 'plan' || data.type === 'plan_update') {
    const text = formatPlanText(data)
    return text
      ? buildClassified('plan', message, text, { event: { type: 'plan' } })
      : null
  }

  if (data.type === 'context_compacted') {
    return buildClassified('session-event', message, 'Conversation compacted', {
      event: { type: 'compact' },
    })
  }

  if (data.type === 'token_count') {
    return buildClassified('session-event', message, 'Context updated', {
      event: { type: 'token-count' },
    })
  }

  if (data.type === 'thread_goal_cleared') {
    return buildClassified('session-event', message, 'Goal cleared', {
      event: { type: 'thread-goal-cleared' },
    })
  }

  if (data.type === 'thread_goal_updated') {
    const status = data.goal && isObject(data.goal) ? String(data.goal.status || '') : ''
    return buildClassified('session-event', message, status ? `Goal ${status}` : 'Goal updated', {
      event: { type: 'thread-goal-updated' },
    })
  }

  return null
}

function buildClassified(kind, message, text, extra = {}) {
  const clean = String(text || '').trim()
  if (!clean) return null
  return {
    kind,
    label: labelForKind(kind),
    seq: Number(message?.seq) || 0,
    text: clean,
    ...extra,
  }
}

function labelForKind(kind) {
  if (kind === 'assistant-reply') return 'assistant'
  if (kind === 'reasoning') return 'thinking'
  if (kind === 'plan') return 'plan'
  if (kind === 'session-event') return 'system-event'
  if (kind === 'api-error') return 'api-error'
  if (kind === 'error') return 'error'
  if (kind === 'summary') return 'summary'
  if (kind === 'tool-call') return 'tool'
  if (kind === 'activity') return 'activity'
  if (kind === 'user') return 'user'
  return kind
}

function unwrapRoleWrappedRecord(value) {
  if (isRoleWrappedRecord(value)) return value
  if (!isObject(value)) return null
  if (isRoleWrappedRecord(value.message)) return value.message
  if (isObject(value.data) && isRoleWrappedRecord(value.data.message)) return value.data.message
  if (isObject(value.payload) && isRoleWrappedRecord(value.payload.message)) return value.payload.message
  return null
}

function isRoleWrappedRecord(value) {
  return isObject(value) && typeof value.role === 'string' && 'content' in value
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isClaudeVisibleMessage(data) {
  if (data.type === 'rate_limit_event') return false
  if (data.type !== 'system') return true
  return VISIBLE_SYSTEM_SUBTYPES.has(data.subtype)
}

/** 仅提取正式回复文本，不包含 thinking */
function extractReplyPlainText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractReplyPlainText).filter(Boolean).join('\n')
  if (!isObject(value)) return value == null ? '' : String(value)

  if (value.message?.role && value.message?.content) return extractReplyPlainText(value.message.content)
  if (value.role && value.content) return extractReplyPlainText(value.content)

  const type = String(value.type || '')
  if (type === 'text') return String(value.text || '')
  if (type === 'thinking' || type === 'reasoning') return ''
  if (['generated-image', 'generated_image'].includes(type)) return ''
  if (['tool_result', 'tool-call-result', 'token_count'].includes(type)) return ''
  if (['tool_use', 'tool-call'].includes(type)) return formatToolCall(value.name, value.input)
  if (type === 'summary') return String(value.summary || '')

  return ''
}

function extractPlainText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractPlainText).filter(Boolean).join('\n')
  if (!isObject(value)) return value == null ? '' : String(value)

  if (value.message?.role && value.message?.content) return extractPlainText(value.message.content)
  if (value.role && value.content) return extractPlainText(value.content)

  const type = String(value.type || '')
  if (type === 'text') return String(value.text || '')
  // thinking 在 classifyClaudeAssistant 单独处理；通用路径仍跳过，避免 user 预览混入
  if (type === 'thinking' || type === 'reasoning') return ''
  if (['generated-image', 'generated_image'].includes(type)) return ''
  if (['tool_result', 'tool-call-result', 'token_count'].includes(type)) return ''
  if (['tool_use', 'tool-call'].includes(type)) return formatToolCall(value.name, value.input)
  if (type === 'summary') return String(value.summary || '')

  return ''
}

function formatPlanText(data) {
  const entries = normalizePlanEntries(data)
  if (!entries.length) return ''
  return entries.map(entry => {
    const mark = entry.status === 'completed' ? 'x' : entry.status === 'in_progress' ? '~' : ' '
    return `- [${mark}] ${entry.step}`
  }).join('\n')
}

function normalizePlanEntries(data) {
  const record = isObject(data) ? data : null
  const raw = Array.isArray(data)
    ? data
    : Array.isArray(record?.entries)
      ? record.entries
      : Array.isArray(record?.items)
        ? record.items
        : Array.isArray(record?.plan)
          ? record.plan
          : Array.isArray(record?.steps)
            ? record.steps
            : []

  const plan = []
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const step = entry.trim()
      if (step) plan.push({ step, status: 'pending' })
      continue
    }
    if (!isObject(entry)) continue
    const step = firstString(entry.step, entry.content, entry.text, entry.title, entry.description)
    if (!step) continue
    plan.push({
      step,
      status: normalizePlanStatus(entry.status ?? entry.state),
    })
  }
  return plan
}

function normalizePlanStatus(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s-]/g, '_') : ''
  if (raw === 'completed' || raw === 'complete' || raw === 'done') return 'completed'
  if (raw === 'in_progress' || raw === 'inprogress' || raw === 'active' || raw === 'running') return 'in_progress'
  return 'pending'
}

function formatToolCall(name, input) {
  const rawName = firstString(name) || '?'
  const tool = normalizeToolDisplayName(rawName)
  const args = isObject(input) ? input : {}
  const command = Array.isArray(args.command)
    ? args.command.filter(item => typeof item === 'string').join(' ')
    : firstString(args.command, args.cmd)
  // Grok/ACP 常把整段命令塞进 name：Execute `ls -la`；优先用 input.command
  if (command) return `${tool}: ${command}`

  const embedded = extractEmbeddedToolCommand(rawName)
  if (embedded) return `${tool}: ${embedded}`

  // Grok read_file 用 target_file；Claude/Codex 用 path/file_path；grep 优先 pattern
  const target = firstString(
    args.description,
    args.target_file,
    args.file_path,
    args.filePath,
    args.file,
    args.pattern,
    args.query,
    args.path,
    args.url,
  )
  if (target) return `${tool}: ${target}`

  return tool
}

/**
 * 把 "Execute `cmd`" / "Shell: free -h" / "Bash(cmd)" 收成短工具名，
 * 便于 markdown 识别并按 bash 高亮。
 */
function normalizeToolDisplayName(name) {
  const text = String(name || '').trim()
  if (!text) return '?'
  // Execute `...` / Shell `...`
  const tick = text.match(/^([A-Za-z][\w.-]{0,40})\s*`/)
  if (tick) return tick[1]
  // Shell: free -h / Read: README.md
  const colon = text.match(/^([A-Za-z][\w.-]{0,40})\s*:\s+/)
  if (colon) return colon[1]
  // Bash(ls -la)
  const paren = text.match(/^([A-Za-z][\w.-]{0,40})\s*\(/)
  if (paren) return paren[1]
  // 多行 name：只取首个标识符
  const first = text.match(/^([A-Za-z][\w.-]{0,40})\b/)
  return first ? first[1] : text.split(/\s+/)[0] || text
}

/** 从 Execute `cmd` / Shell: cmd / Bash(cmd) 名称中抽出命令正文 */
function extractEmbeddedToolCommand(name) {
  const text = String(name || '').trim()
  if (!text) return ''
  const tick = text.match(/^[A-Za-z][\w.-]{0,40}\s*`([\s\S]*?)`\s*$/)
  if (tick?.[1]?.trim()) return tick[1].trim()
  const colon = text.match(/^[A-Za-z][\w.-]{0,40}\s*:\s+([\s\S]+)$/)
  if (colon?.[1]?.trim()) return colon[1].trim()
  const paren = text.match(/^[A-Za-z][\w.-]{0,40}\s*\(([\s\S]*)\)\s*$/)
  if (paren?.[1]?.trim()) return paren[1].trim()
  return ''
}

function formatApiError(data) {
  const retryAttempt = Number(data.retryAttempt) || 0
  const maxRetries = Number(data.maxRetries) || 0
  if (maxRetries > 0 && retryAttempt >= maxRetries) return 'API error: Max retries reached'
  if (maxRetries > 0) return `API error: Retrying (${retryAttempt}/${maxRetries})`
  if (retryAttempt > 0) return 'API error: Retrying...'
  return 'API error'
}

function withErrorDetail(text, error) {
  const detail = stringifyError(error)
  return detail ? `${text}\n错误: ${detail}` : text
}

function stringifyError(error) {
  if (error == null) return ''
  if (typeof error === 'string') return error.trim()
  if (error instanceof Error) return error.message || String(error)
  if (isObject(error)) {
    for (const key of ['message', 'error', 'reason', 'detail']) {
      const value = error[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function formatEventText(event) {
  if (event.type === 'api-error') return formatApiError(event)
  if (event.type === 'error') return typeof event.message === 'string' ? event.message : 'Error'
  if (event.type === 'message') return typeof event.message === 'string' ? event.message : 'Message'
  if (event.type === 'switch') return `Switched to ${event.mode === 'local' ? 'local' : 'remote'}`
  if (event.type === 'title-changed') return event.title ? `Title changed to "${event.title}"` : 'Title changed'
  if (event.type === 'permission-mode-changed') return `Permission mode: ${event.mode || 'default'}`
  if (event.type === 'turn-duration') return `Turn: ${formatDuration(Number(event.durationMs) || 0)}`
  if (event.type === 'microcompact') {
    const saved = Number(event.tokensSaved) || 0
    const formatted = saved >= 1000 ? `${Math.round(saved / 1000)}K` : String(saved)
    return `Context compacted (saved ${formatted} tokens)`
  }
  if (event.type === 'compact') return 'Conversation compacted'
  if (event.type === 'thread-goal-cleared') return 'Goal cleared'
  if (event.type === 'token-count') return 'Context updated'
  if (event.type === 'limit-reached') return 'Usage limit reached'
  if (event.type === 'limit-warning') return 'Usage limit warning'
  try {
    return JSON.stringify(event)
  } catch {
    return String(event.type)
  }
}

function formatDuration(ms) {
  const value = Math.max(0, Number(ms) || 0)
  if (value < 1000) return `${Math.round(value)}ms`
  const seconds = value / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`
}
