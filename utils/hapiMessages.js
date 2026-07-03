const AGENT_MESSAGE_PAYLOAD_TYPE = 'codex'

const VISIBLE_SYSTEM_SUBTYPES = new Set([
  'api_error',
  'turn_duration',
  'microcompact_boundary',
  'compact_boundary',
])

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
  const seq = item.seq ? ` #${item.seq}` : ''
  return `${item.label}${seq}\n${item.text}`
}

export function classifyHapiMessages(messages, options = {}) {
  const includeUsers = options.includeUsers !== false
  return (Array.isArray(messages) ? messages : [])
    .map(item => classifyHapiMessage(item))
    .filter(item => item && (includeUsers || item.kind !== 'user'))
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

function classifyClaudeOutput(message, data) {
  if (!isObject(data) || typeof data.type !== 'string') return null
  if (data.isMeta || data.isCompactSummary) return null
  if (!isClaudeVisibleMessage(data)) return null

  if (data.type === 'assistant') {
    const text = extractAssistantOutputText(data)
    return text ? buildClassified('assistant-reply', message, text) : null
  }

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
  if (kind === 'session-event') return 'system-event'
  if (kind === 'api-error') return 'api-error'
  if (kind === 'error') return 'error'
  if (kind === 'summary') return 'summary'
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

function extractAssistantOutputText(data) {
  const message = isObject(data.message) ? data.message : null
  if (!message) return ''
  return extractPlainText(message.content)
}

function extractPlainText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractPlainText).filter(Boolean).join('\n')
  if (!isObject(value)) return value == null ? '' : String(value)

  if (value.message?.role && value.message?.content) return extractPlainText(value.message.content)
  if (value.role && value.content) return extractPlainText(value.content)

  const type = String(value.type || '')
  if (type === 'text') return String(value.text || '')
  if (type === 'thinking') return ''
  if (['generated-image', 'generated_image'].includes(type)) return ''
  if (['tool_result', 'tool-call-result', 'token_count', 'tool_use', 'tool-call'].includes(type)) return ''
  if (type === 'summary') return String(value.summary || '')

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
