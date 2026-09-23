import { formatHapiMessageNodes } from './hapiMessages.js'
import { getFlavorDisplay } from './flavorProfiles.js'
import { normalizePokeAction } from './pokeActions.js'

export function getSessionTitle(session) {
  const meta = session?.metadata || {}
  for (const value of [session?.thread_name, meta.thread_name, meta.name, session?.name, session?.title, meta.title]) {
    const title = cleanTitle(value)
    if (title) return title
  }
  for (const summary of [session?.summary, meta.summary]) {
    const summaryTitle = cleanTitle(summary)
    if (summaryTitle) return summaryTitle
  }
  return '(无标题)'
}

function cleanTitle(value) {
  if (value && typeof value === 'object') value = value.text ?? value.name ?? value.title ?? value.summary
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

export function extractTextPreview(content, maxLen = 0) {
  const limit = maxLen > 0 ? maxLen : 999999
  const inner = content?.content ?? content
  const text = extractInner(inner, limit)
  return text && text.trim() ? text : null
}

function extractInner(value, limit) {
  if (typeof value === 'string') return value.slice(0, limit)
  if (Array.isArray(value)) return value.map(item => extractInner(item, limit)).filter(Boolean).join('\n')
  if (!value || typeof value !== 'object') return value == null ? '' : String(value).slice(0, limit)

  if (value.message?.role && value.message?.content) return extractInner(value.message.content, limit)
  if (value.role && value.content) return extractInner(value.content, limit)

  const type = value.type || ''
  if (type === 'text') return String(value.text || '').slice(0, limit)
  // 与 WebUI / hapiMessages 对齐：thinking/reasoning 可见
  if (type === 'thinking') return String(value.thinking || value.text || '').slice(0, limit)
  if (type === 'reasoning') return String(value.message || value.text || '').slice(0, limit)
  if (['generated-image', 'generated_image'].includes(type)) return ''
  if (['tool_result', 'tool-call-result', 'token_count'].includes(type)) return ''
  if (['tool_use', 'tool-call'].includes(type)) {
    const name = value.name || '?'
    const input = value.input && typeof value.input === 'object' ? value.input : {}
    const command = Array.isArray(input.command)
      ? input.command.filter(item => typeof item === 'string').join(' ')
      : (typeof input.command === 'string' ? input.command : '')
    if (command) return `${name}: ${String(command).slice(0, limit)}`
    for (const key of ['description', 'target_file', 'file_path', 'filePath', 'file', 'pattern', 'query', 'path', 'url']) {
      if (typeof input[key] === 'string' && input[key].trim()) {
        return `${name}: ${input[key].slice(0, limit)}`
      }
    }
    return String(name)
  }
  if (type === 'plan' || type === 'plan_update') {
    const plan = value.entries || value.items || value.plan || value.steps
    if (Array.isArray(plan) && plan.length) {
      return plan.map(entry => {
        if (typeof entry === 'string') return `- ${entry}`
        const step = entry?.step || entry?.content || entry?.text || entry?.title || ''
        return step ? `- ${step}` : ''
      }).filter(Boolean).join('\n').slice(0, limit)
    }
  }
  if (type === 'event') {
    const eventType = value.data?.type
    if (eventType === 'ready') return ''
    if (eventType === 'message') return `系统: ${value.data?.message || ''}`
    return eventType ? `系统: ${eventType}` : ''
  }
  if (type === 'summary') return value.summary ? `摘要: ${String(value.summary).slice(0, limit)}` : ''
  if (type === 'codex') return extractInner(value.data, limit)

  for (const key of ['text', 'data', 'content', 'message', 'output']) {
    const found = extractInner(value[key], limit)
    if (found) return found
  }
  return ''
}

export function sessionLabel(sessionOrSid, sessions = []) {
  const session = resolveSessionRef(sessionOrSid, sessions)
  const sid = typeof sessionOrSid === 'string' ? sessionOrSid : sessionOrSid?.id
  if (!session) return `会话 ${String(sid || '').slice(0, 8)}`
  const meta = session.metadata || {}
  const title = getSessionTitle(session)
  const path = meta.path || '(无路径)'
  const flavor = getFlavorDisplay(meta.flavor)
  return `${title}\n路径: ${path}\n${flavor} | ${session.id.slice(0, 8)}`
}

export function sessionLabelWithRuntime(sessionOrSid, sessions = []) {
  const label = sessionLabel(sessionOrSid, sessions)
  const runtime = sessionRuntimeInfo(sessionOrSid, sessions)
  if (!runtime) return label
  const lines = String(label).split('\n')
  lines[lines.length - 1] = `${lines[lines.length - 1]} | ${runtime}`
  return lines.join('\n')
}

export function sessionRuntimeInfo(sessionOrSid, sessions = []) {
  const session = resolveSessionRef(sessionOrSid, sessions)
  if (!session) return ''
  const meta = session.metadata || {}
  const flavor = String(meta.flavor || '').toLowerCase()
  const permission = firstNonEmpty(session.permissionMode, session.permission_mode) || 'default'
  const model = firstNonEmpty(session.model, session.modelMode, session.model_mode) || 'default'
  const effort = formatReasoningEffort(session, flavor)
  const values = [permission, model, effort]
  if (isPlanSession(session) && !values.includes('plan')) values.push('plan')
  return values.join(' | ')
}

function resolveSessionRef(sessionOrSid, sessions = []) {
  return typeof sessionOrSid === 'string'
    ? sessions.find(item => item.id === sessionOrSid)
    : sessionOrSid
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue
    const text = String(value).trim()
    if (text) return text
  }
  return ''
}

function formatReasoningEffort(session, flavor = '') {
  const effectiveModelReasoningEffort = firstNonEmpty(
    session.effectiveModelReasoningEffort,
    session.effective_model_reasoning_effort,
  )
  const modelReasoningEffort = firstNonEmpty(session.modelReasoningEffort, session.model_reasoning_effort)
  const effort = firstNonEmpty(session.effort)
  if (effectiveModelReasoningEffort) return effectiveModelReasoningEffort
  if (modelReasoningEffort) return modelReasoningEffort
  if (effort) return effort
  if (flavor === 'claude') return 'auto'
  if (flavor === 'grok') return 'default'
  if (['codex', 'opencode'].includes(flavor)) return '继承默认'
  return 'default'
}

function isPlanSession(session) {
  return session.permissionMode === 'plan' || session.collaborationMode === 'plan'
}

export function formatSessionList(sessions, currentSid = '', allSessions = null, options = {}) {
  if (!sessions.length) return '没有任何 session'
  const indexBySid = new Map()
    ; (allSessions || sessions).forEach((item, idx) => indexBySid.set(item.id, idx + 1))
  const routeLabel = typeof options.routeLabel === 'function' ? options.routeLabel : null
  const pendingBySid = options.pendingBySid || {}

  const lines = [`共 ${sessions.length} 个 Session:`]
  let lastPath = null
  for (const session of sessions) {
    const meta = session.metadata || {}
    const path = meta.path || '(无路径)'
    if (path !== lastPath) {
      const count = sessions.filter(item => (item.metadata?.path || '(无路径)') === path).length
      lines.push('', `目录: ${path} (${count})`)
      lastPath = path
    }
    const idx = indexBySid.get(session.id)
    const title = getSessionTitle(session)
    const status = session.thinking ? '思考中' : session.active ? '运行中' : '已关闭'
    const pending = session.pendingRequestsCount ? ` | ${session.pendingRequestsCount} 待审批` : ''
    const current = currentSid === session.id ? ' | <<当前' : ''
    lines.push(`[${idx} | ${session.id.slice(0, 8)}] ${title}`)
    lines.push(`${status} | ${getFlavorDisplay(meta.flavor)}:${session.modelMode || 'default'}${pending}${current}`)
    if (routeLabel) lines.push(`推送: ${routeLabel(session)}`)
    for (const line of pendingTipsLines(session, pendingBySid)) lines.push(line)
  }
  lines.push('', '切换会话：\n #hapi sw <序号或ID前缀>')
  return lines.join('\n')
}

/** 生成单个待审批请求的指令提示：#<序号> <工具> → #hapi allow/answer <序号> */
function pendingTip(req) {
  const idx = req?.index || 0
  const name = String(req?.tool || '')
  if (isQuestionRequest(req)) return `#${idx} ${name || '问题'} → #hapi answer ${idx} <答案>`
  return `#${idx} ${name || '普通'} → #hapi allow ${idx}`
}

/**
 * 把某会话的待审批请求拆成两行提示：
 * - 「⚡ 待回答 N 个」：question 类请求（AskUserQuestion 等），用 #hapi answer 回答
 * - 「⚡ 待审批 N 个」：普通权限请求（Bash/Read 等），用 #hapi allow 批准
 * 有待回答请求时额外附上 #hapi pending 帮助行，提示用户查看问题与待选答案。
 * 无实时请求明细但 REST 显示有 pendingRequestsCount 时，给出通用指令提示。
 */
function pendingTipsLines(session, pendingBySid) {
  const items = pendingBySid[session.id] || []
  const lines = []
  if (items.length) {
    const questionItems = items.filter(item => isQuestionRequest(item.req))
    const normalItems = items.filter(item => !isQuestionRequest(item.req))
    if (questionItems.length) {
      lines.push(`⚡ 待回答 ${questionItems.length} 个: ${questionItems.map(item => pendingTip(item.req)).join('；')}`)
      lines.push('ℹ️ #hapi pending 查看完整问题与选项')
    }
    if (normalItems.length) {
      lines.push(`⚡ 待审批 ${normalItems.length} 个: ${normalItems.map(item => pendingTip(item.req)).join('；')}`)
    }
  } else if (session.pendingRequestsCount) {
    lines.push(`⚡ ${session.pendingRequestsCount} 个待审批/待回答：#hapi pending 查看明细；#hapi allow <序号> 批准 / #hapi answer <序号> <答案> 回答`)
  }
  return lines
}

export function formatSessionListNodes(sessions, currentSid = '', allSessions = null, options = {}) {
  if (!sessions.length) return ['没有任何 session']
  const indexBySid = new Map()
    ; (allSessions || sessions).forEach((item, idx) => indexBySid.set(item.id, idx + 1))
  const routeLabel = typeof options.routeLabel === 'function' ? options.routeLabel : null
  const pendingBySid = options.pendingBySid || {}

  const pathCounts = new Map()
  for (const session of sessions) {
    const path = session.metadata?.path || '(无路径)'
    pathCounts.set(path, (pathCounts.get(path) || 0) + 1)
  }

  const nodes = [`共 ${sessions.length} 个 Session:`]

  for (const session of sessions) {
    const meta = session.metadata || {}
    const path = meta.path || '(无路径)'
    const title = getSessionTitle(session)
    const status = session.thinking ? '思考中' : session.active ? '运行中' : '已关闭'
    const pending = session.pendingRequestsCount ? ` | ${session.pendingRequestsCount} 待审批` : ''
    const current = currentSid === session.id ? ' | <<当前' : ''
    const lines = [
      `目录: ${path} (${pathCounts.get(path) || 1})`,
      `[${indexBySid.get(session.id)} | ${session.id.slice(0, 8)}] ${title}`,
      `${status} | ${getFlavorDisplay(meta.flavor)}:${session.modelMode || 'default'}${pending}${current}`,
    ]
    if (routeLabel) lines.push(`推送: ${routeLabel(session)}`)
    for (const line of pendingTipsLines(session, pendingBySid)) lines.push(line)
    nodes.push(lines.join('\n'))
  }

  // 检查运行中的会话数量，如果 >= 4 个则添加提醒
  const activeSessions = sessions.filter(session => session.active)
  if (activeSessions.length >= 4) {
    nodes.push([
      '⚠️ 内存提醒',
      `当前有 ${activeSessions.length} 个运行中的会话`,
      '每个运行中的 session 都会消耗内存，请及时关闭不需要的会话',
      '使用 #hapi abort [目标] 中断会话',
    ].join('\n'))
  }

  nodes.push('切换会话：\n #hapi sw <序号或ID前缀>')
  return nodes
}

export function formatSessionStatus(session) {
  const meta = session.metadata || {}
  const flavor = String(meta.flavor || '').toLowerCase()
  const lines = [
    `Session:  ${session.id?.slice(0, 8)}...`,
    `标题:     ${getSessionTitle(session)}`,
    `Flavor:   ${getFlavorDisplay(meta.flavor)}`,
    `Path:     ${meta.path || '?'}`,
    `Active:   ${Boolean(session.active)}`,
    `Thinking: ${Boolean(session.thinking)}`,
    `权限模式: ${session.permissionMode || 'default'}`,
    `模型:     ${firstNonEmpty(session.model, session.modelMode, session.model_mode) || 'default'}`,
  ]
  if (['claude', 'codex', 'grok', 'opencode', 'pi'].includes(flavor)) {
    lines.push(`推理强度: ${formatReasoningEffort(session, flavor)}`)
  }
  if (flavor === 'codex') {
    lines.push(`协作模式: ${session.collaborationMode || 'default'}`)
    lines.push(`Service Tier: ${firstNonEmpty(session.serviceTier, session.service_tier) || 'standard'}`)
  }
  return lines.join('\n')
}

export function formatMessages(messages) {
  if (!messages.length) return '(暂无消息)'
  const lines = formatHapiMessageNodes(messages).map(node => node.replace('\n', ': '))
  return lines.join('\n\n') || '(暂无可显示的消息)'
}

export function formatMessageNodes(messages) {
  return formatHapiMessageNodes(messages)
}

export function isQuestionRequest(req) {
  return ['AskUserQuestion', 'ask_user_question', 'request_user_input'].includes(req.tool)
}

export function formatRequestDetail(req) {
  if (!req) return '?'
  const args = req.arguments || {}
  if (req.tool === '__compact__') return '压缩上下文 (/compact)'
  if (args.command) return `${req.tool}: ${String(args.command).slice(0, 150)}`
  const text = JSON.stringify(args, null, 0)
  return text && text !== '{}' ? `${req.tool}: ${text.slice(0, 150)}` : req.tool || '?'
}

// 兼容 arguments 为对象或 JSON 字符串，取出 AskUserQuestion 的 questions 数组
function parseQuestions(req) {
  let args = req?.arguments
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { return [] }
  }
  return Array.isArray(args?.questions) ? args.questions : []
}

// 权限请求的完整详情（不像 formatRequestDetail 截断到 150，转发节点里可放更多）
function formatRequestFull(req) {
  if (req.tool === '__compact__') return '压缩上下文 (/compact)'
  const args = req.arguments || {}
  let body = ''
  if (typeof args === 'string') body = args
  else if (args.command) body = String(args.command)
  else body = JSON.stringify(args, null, 2)
  if (!body || body === '{}') return req.tool || '?'
  return `${req.tool}:\n${body.slice(0, 1500)}`
}

/**
 * 把用户输入的答案文本解析为 HAPI approve 接口的 answers 结构。
 * - 不含 / 时视为单问题回答：{ "0": [答案] }
 * - 含 / 时按顺序分隔多问题：{ "0": [a0], "1": [a1], ... }（空段自动忽略）
 * - 段数超过 questionCount 时返回 { error: true }，由调用方提示
 */
export function parseAnswerText(text, questionCount = 0) {
  const raw = String(text || '').trim()
  if (!raw) return { answers: { '0': [''] } }
  const count = Number(questionCount) || 0
  const parts = raw.split('/').map(item => item.trim()).filter(Boolean)
  if (parts.length <= 1) return { answers: { '0': [raw] } }
  if (count > 0 && parts.length > count) return { error: true }
  const answers = {}
  parts.forEach((part, index) => { answers[String(index)] = [part] })
  return { answers }
}

/** question 请求包含的问题数量 */
export function countQuestions(req) {
  return parseQuestions(req).length
}

/** 一行式会话标识：[会话] id前8位 · flavor · 标题/路径末段 */
function sessionOneLine(session) {
  const meta = session?.metadata || {}
  const flavor = getFlavorDisplay(meta.flavor)
  const id = String(session?.id || '').slice(0, 8)
  let name = getSessionTitle(session)
  if (name === '(无标题)') {
    const path = String(meta.path || '')
    name = path ? String(path).split('/').filter(Boolean).pop() || path : '(无标题)'
  }
  if (name.length > 30) name = `${name.slice(0, 29)}…`
  return `[会话] ${[id, flavor, name].filter(Boolean).join(' · ')}`
}

/** question 请求卡片：[待回答] #序号 / 会话 / 每题+选项(内联指令) / 回答操作行 */
function formatQuestionCard(req, label) {
  const idx = req.index || 0
  const questions = parseQuestions(req)
  const multi = questions.length > 1
  const lines = [`[待回答] #${idx}`, label]
  if (questions.length) {
    questions.forEach((q, qi) => {
      const head = [q.header, q.question].filter(Boolean).join('：')
      if (head) lines.push(multi ? `Q${qi + 1}. ${head}` : head)
      for (const opt of (Array.isArray(q.options) ? q.options : [])) {
        if (!opt?.label) continue
        const desc = opt.description ? `（${opt.description}）` : ''
        lines.push(`  - ${opt.label}${desc} → #hapi answer ${idx} ${opt.label}`)
      }
    })
  } else {
    lines.push(formatRequestDetail(req))
  }
  let hint = ''
  if (multi) {
    const example = questions.map(q => q.options?.[0]?.label || '<答案>')
    const shown = example.length > 3 ? `${example.slice(0, 3).join(' / ')} / …` : example.join(' / ')
    hint = `（多问题按顺序用 / 分隔，如 ${shown}）`
  }
  lines.push(`回答：#hapi answer ${idx} <答案>${hint}`)
  return lines.join('\n')
}

/** 普通权限请求卡片：[待审批] #序号 / 会话 / 详情 / 操作行 */
function formatPermissionCard(req, label) {
  const idx = req.index || 0
  return [
    `[待审批] #${idx}`,
    label,
    formatRequestFull(req),
    `批准：#hapi allow ${idx} ｜ 本会话允许：#hapi as ${idx} ｜ 拒绝：#hapi deny ${idx}`,
  ].join('\n')
}

/** 统一请求卡片（pending / 提问提醒 / list 共用）：根据请求类型分派到 question / permission 卡片 */
export function formatRequestCard(req, sessionOrSid, sessions = []) {
  const session = typeof sessionOrSid === 'string'
    ? sessions.find(item => item.id === sessionOrSid)
    : sessionOrSid
  const label = sessionOneLine(session)
  return isQuestionRequest(req) ? formatQuestionCard(req, label) : formatPermissionCard(req, label)
}

/**
 * 把一个待审批/问题请求拆成「合并转发」节点：
 * - 卡片节点（完整问题+选项+操作行）
 * - 末尾指令节点（全局审批指令）+ 可选戳一戳提示
 * @returns {string[]} 节点字符串数组
 */
export function formatRequestNodes(sid, req, total, sessions, config = {}) {
  const question = isQuestionRequest(req)
  const cmdNode = [
    `当前共 ${total} 个待审批`,
    question ? `#hapi answer ${req.index} <答案>` : `#hapi allow ${req.index}`,
    ...(question ? [] : [`#hapi as ${req.index} 本会话允许`]),
    '#hapi a 批准全部普通请求',
    '#hapi deny 拒绝',
  ].join('\n')
  // 仅当戳一戳配置为 approve 时展示批准提示。
  const pokeNode = config.enable_poke_approve && (!config.poke_action || config.poke_action === 'approve')
    ? '“戳一戳我”批准全部普通请求'
    : ''

  const nodes = [formatRequestCard(req, sid, sessions)]
  nodes.push(cmdNode)
  if (pokeNode) nodes.push(pokeNode)
  return nodes
}

export function formatPending(pending, sessions) {
  const items = []
  for (const [sid, reqs] of Object.entries(pending)) {
    for (const [rid, req] of Object.entries(reqs)) items.push([sid, rid, req])
  }
  if (!items.length) return '没有待审批的请求'
  const questionCount = items.filter(([, , req]) => isQuestionRequest(req)).length
  const normalCount = items.length - questionCount
  const lines = [`⚡ 待回答 ${questionCount} · 待审批 ${normalCount} · 共 ${items.length}（全部会话，非当前 #hapi sw 会话；#hapi list 查看）`]
  for (const [sid, rid, req] of items) {
    lines.push('')
    lines.push(formatRequestCard(req, sid, sessions))
  }
  lines.push('', '#hapi a 批准全部普通请求')
  lines.push('#hapi allow <序号> 批准单个普通请求')
  lines.push('#hapi as <序号> 本会话允许单个普通请求')
  lines.push('#hapi deny [序号] 拒绝请求')
  return lines.join('\n')
}

export function formatDirectory(entries, currentPath = '.', detail = true) {
  if (!entries.length) return `${currentPath}\n（空目录）`
  const dirs = entries.filter(item => item.type === 'directory').sort((a, b) => a.name.localeCompare(b.name))
  const files = entries.filter(item => item.type !== 'directory').sort((a, b) => a.name.localeCompare(b.name))
  const lines = [`${currentPath} (${dirs.length} 个文件夹, ${files.length} 个文件)`]
  for (const item of dirs) lines.push(`  [D] ${item.name}/`)
  for (const item of files) lines.push(`  [F] ${item.name}${detail && item.size ? ` (${formatSize(item.size)})` : ''}`)
  return lines.join('\n')
}

export function formatFiles(files, query) {
  if (!files.length) return `未找到匹配「${query}」的文件`
  const lines = [`搜索「${query}」(${files.length} 个结果):`]
  for (const [idx, file] of files.slice(0, 50).entries()) {
    lines.push(`  [${idx + 1}] ${file.fullPath || file.path || file.fileName || file.name || file}`)
  }
  if (files.length > 50) lines.push(`  ... 还有 ${files.length - 50} 个未显示`)
  return lines.join('\n')
}

export function formatSize(size) {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)}MB`
  if (size >= 1024) return `${(size / 1024).toFixed(1)}KB`
  return `${size}B`
}

export function helpText(topic = '') {
  return helpNodes(topic).join('\n\n')
}

export function helpNodes(topic = '', config = {}) {
  const quickPrefix = quickSendHelpPrefix(config)
  const quickSendLines = quickPrefix
    ? [
      `${quickPrefix} 内容                  快捷发到当前 session`,
      `${quickPrefix}{2} 内容               快捷发到第 2 个 session`,
      `${quickPrefix} 上传附件3张 [内容]      等待附件后发到当前 session`,
      `${quickPrefix} {2} 上传附件5份 [内容]  等待附件后发到第 2 个 session`,
    ]
    : ['快捷发送已关闭，可在锅巴中开启并设置快捷前缀']

  return [
    [
      'HAPI Connector / 会话与对话',
      '',
      '#hapi list [all]        查看[当前聊天/全部] session',
      '#hapi sw <序号|ID前缀>  切换当前 session',
      '#hapi s                 查看当前状态',
      '#hapi msg [条数]        查看最近消息',
      '#hapi diff              以图片查看当前工作区未暂存变更',
      '#hapi to <序号> <内容>  发消息到指定 session',
      ...quickSendLines,
    ].join('\n'),
    [
      '权限审批',
      '',
      '#hapi pending           查看待审批',
      '#hapi a                 批准全部普通请求',
      '#hapi allow <序号>      批准单个普通请求',
      '#hapi as <序号>         本会话允许单个普通请求',
      '#hapi answer <序号> <答案> 回答 question 请求，不是普通聊天',
      '#hapi deny [序号]       拒绝全部或单个请求',
      `戳一戳机器人            ${pokeActionHelp(config)}`,
    ].join('\n'),
    [
      'Session 管理',
      '',
      '#hapi machines          查看在线机器',
      '#hapi create <machineId> <目录> <agent> [simple|worktree] [模型] [推理强度] [权限模式] [yolo]',
      '#hapi abort [目标]      中断 session',
      '#hapi 取消重试 [目标|all] 取消自动 continue 重试',
      '#hapi archive           归档当前 session',
      '#hapi resume [目标]     恢复 inactive session',
      '#hapi rename <标题>     重命名当前 session',
      '#hapi delete [目标]     删除 session',
      '#hapi trim <数量>       删除倒数 N 个已关闭会话',
      '#hapi clean [路径]      删除已关闭会话（交互选择）',
    ].join('\n'),
    [
      '文件操作',
      '',
      '#hapi files [路径]      浏览远端目录',
      '#hapi files -l [路径]   浏览目录并显示大小',
      '#hapi find <关键词>     搜索远端文件',
      '#hapi read <路径>       读取远端小文件',
      '#hapi download <路径>   下载远端文件',
      '#hapi upload [附件]     上传附件到当前 session',
      '#hapi upload cancel     删除当前 session 已上传 blob',
    ].join('\n'),
    [
      '模式与通知',
      '',
      '#hapi perm [模式]       查看/切换权限模式',
      '#hapi model [模式]      查看/切换模型，支持 opus[1m]',
      '#hapi effort [值]       查看/切换推理强度',
      '#hapi plan              切换 Plan 模式',
      '#hapi fast [值]         切换 Fast 模式',
      '#hapi output [级别]     查看/切换推送级别，不带值会等待下一条消息',
      '#hapi bind              设置默认通知窗口',
      '#hapi bind status       查看通知路由',
      '#hapi bind reset        清除当前窗口绑定',
      '#hapi bind clean        清除默认通知窗口',
      '#hapi更新              更新插件',
      '#hapi强制更新          强制更新插件',
    ].join('\n'),
    createExampleNode(),
  ]
}

function pokeActionHelp(config = {}) {
  if (config.enable_poke_approve === false) return '戳一戳动作已关闭'
  const labels = {
    approve: '批准全部普通请求',
    pending: '查看待审批',
    list: '查看会话列表',
    status: '查看当前状态',
    stop: '中止当前 session',
    output_cycle: '循环切换推送级别',
    none: '仅确认收到戳一戳',
  }
  return labels[normalizePokeAction(config.poke_action)]
}

function quickSendHelpPrefix(config = {}) {
  if (config.quick_send_enabled === false) return ''
  const prefix = config.quick_prefix === undefined || config.quick_prefix === null
    ? '>'
    : String(config.quick_prefix)
  return prefix
}

function createExampleNode() {
  return [
    '使用引导模式创建新对话：',
    ' #hapi create',
    '',
    '创建 Claude Code 会话，并使用 Opus 模型、high 思考强度、bypassPermissions 权限示例：',
    ' #hapi create my-pc /root/project claude simple opus high bypassPermissions',
    '',
    '如果已经创建好当前 session，也可以分步设置：',
    ' #hapi model opus',
    ' #hapi effort high',
    ' #hapi perm bypassPermissions',
    '',
    '需要 1M 上下文模型时：#hapi model opus[1m]',
  ].join('\n')
}
