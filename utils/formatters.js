export const PERMISSION_MODES = {
  claude: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  codex: ['default', 'read-only', 'safe-yolo', 'yolo'],
  gemini: ['default', 'read-only', 'safe-yolo', 'yolo'],
  opencode: ['default', 'yolo'],
}

export const MODEL_MODES = ['default', 'sonnet', 'sonnet[1m]', 'opus', 'opus[1m]', 'fable', 'fable[1m]']
export const GEMINI_MODEL_MODES = ['default', 'flash', 'pro']
export const CLAUDE_EFFORTS = ['', 'medium', 'high', 'max']
export const CODEX_EFFORTS = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']

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
  if (['tool_result', 'tool-call-result', 'token_count', 'thinking'].includes(type)) return ''
  if (['tool_use', 'tool-call'].includes(type)) {
    const name = value.name || '?'
    const input = value.input || {}
    const command = typeof input === 'object' ? input.command : ''
    return command ? `工具 ${name}: ${command.slice(0, limit)}` : `工具 ${name}`
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
  const session = typeof sessionOrSid === 'string'
    ? sessions.find(item => item.id === sessionOrSid)
    : sessionOrSid
  const sid = typeof sessionOrSid === 'string' ? sessionOrSid : sessionOrSid?.id
  if (!session) return `会话 ${String(sid || '').slice(0, 8)}`
  const meta = session.metadata || {}
  const title = meta.summary?.text || meta.name || '(无标题)'
  const path = meta.path || '(无路径)'
  const flavor = meta.flavor || '?'
  return `${title}\n路径: ${path}\n${flavor} | ${session.id.slice(0, 8)}`
}

export function formatSessionList(sessions, currentSid = '', allSessions = null) {
  if (!sessions.length) return '没有任何 session'
  const indexBySid = new Map()
  ;(allSessions || sessions).forEach((item, idx) => indexBySid.set(item.id, idx + 1))

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
    const title = meta.summary?.text || meta.name || '(无标题)'
    const status = session.thinking ? '思考中' : session.active ? '运行中' : '已关闭'
    const pending = session.pendingRequestsCount ? ` | ${session.pendingRequestsCount} 待审批` : ''
    const current = currentSid === session.id ? ' | <<当前' : ''
    lines.push(`[${idx} | ${session.id.slice(0, 8)}] ${title}`)
    lines.push(`${status} | ${meta.flavor || '?'}:${session.modelMode || 'default'}${pending}${current}`)
  }
  lines.push('', '切换会话：\n #hapi sw <序号或ID前缀>')
  return lines.join('\n')
}

export function formatSessionListNodes(sessions, currentSid = '', allSessions = null) {
  if (!sessions.length) return ['没有任何 session']
  const indexBySid = new Map()
  ;(allSessions || sessions).forEach((item, idx) => indexBySid.set(item.id, idx + 1))

  const pathCounts = new Map()
  for (const session of sessions) {
    const path = session.metadata?.path || '(无路径)'
    pathCounts.set(path, (pathCounts.get(path) || 0) + 1)
  }

  const nodes = [`共 ${sessions.length} 个 Session:`]

  for (const session of sessions) {
    const meta = session.metadata || {}
    const path = meta.path || '(无路径)'
    const title = meta.summary?.text || meta.name || '(无标题)'
    const status = session.thinking ? '思考中' : session.active ? '运行中' : '已关闭'
    const pending = session.pendingRequestsCount ? ` | ${session.pendingRequestsCount} 待审批` : ''
    const current = currentSid === session.id ? ' | <<当前' : ''
    nodes.push([
      `目录: ${path} (${pathCounts.get(path) || 1})`,
      `[${indexBySid.get(session.id)} | ${session.id.slice(0, 8)}] ${title}`,
      `${status} | ${meta.flavor || '?'}:${session.modelMode || 'default'}${pending}${current}`,
    ].join('\n'))
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
  const lines = [
    `Session:  ${session.id?.slice(0, 8)}...`,
    `标题:     ${meta.summary?.text || meta.name || '(无标题)'}`,
    `Flavor:   ${meta.flavor || '?'}`,
    `Path:     ${meta.path || '?'}`,
    `Active:   ${Boolean(session.active)}`,
    `Thinking: ${Boolean(session.thinking)}`,
    `权限模式: ${session.permissionMode || 'default'}`,
    `模型:     ${session.modelMode || 'default'}`,
  ]
  if (meta.flavor === 'codex') lines.push(`协作模式: ${session.collaborationMode || 'default'}`)
  return lines.join('\n')
}

export function formatMessages(messages) {
  if (!messages.length) return '(暂无消息)'
  const lines = []
  for (const msg of messages) {
    const content = msg.content || {}
    const role = content.message?.role || content.role || '?'
    const text = extractTextPreview(content)
    if (!text) continue
    lines.push(`${role}: ${text}`)
  }
  return lines.join('\n\n') || '(暂无可显示的消息)'
}

export function formatMessageNodes(messages) {
  if (!messages.length) return ['(暂无消息)']
  const nodes = []
  for (const msg of messages) {
    const content = msg.content || {}
    const role = content.message?.role || content.role || '?'
    const text = extractTextPreview(content)
    if (!text) continue
    const seq = msg.seq ? ` #${msg.seq}` : ''
    nodes.push(`${role}${seq}\n${text}`)
  }
  return nodes.length ? nodes : ['(暂无可显示的消息)']
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
 * 把一个待审批/问题请求拆成多个「合并转发」节点，方便复制指令。
 * - 问题请求(AskUserQuestion)：标题节点 + 每个选项一个节点(选项/说明/可直接复制的 #hapi answer) + 末尾指令节点
 * - 普通权限请求：标题节点 + 完整详情节点 + 末尾指令节点
 * @returns {string[]} 节点字符串数组
 */
export function formatRequestNodes(sid, req, total, sessions, config = {}) {
  const label = sessionLabel(sid, sessions)
  const question = isQuestionRequest(req)
  const cmdLines = [
    `当前共 ${total} 个待审批`,
    question ? `#hapi answer ${req.index} <答案>` : `#hapi allow ${req.index}`,
    '#hapi a 批准全部普通请求',
    '#hapi deny 拒绝',
  ]
  if (config.enable_poke_approve) cmdLines.push('“戳一戳我”批准全部普通请求')
  const cmdNode = cmdLines.join('\n')

  if (question) {
    const questions = parseQuestions(req)
    const nodes = [`问题请求 #${req.index}\n${label}`]
    if (questions.length) {
      for (const q of questions) {
        const head = [q.header, q.question].filter(Boolean).join('\n')
        if (head) nodes.push(head)
        for (const opt of (Array.isArray(q.options) ? q.options : [])) {
          if (!opt?.label) continue
          const parts = [opt.label]
          if (opt.description) parts.push(opt.description)
          parts.push(`#hapi answer ${req.index} ${opt.label}`)
          nodes.push(parts.join('\n'))
        }
      }
    } else {
      nodes.push(formatRequestDetail(req))
    }
    nodes.push(cmdNode)
    return nodes
  }

  return [`权限请求 #${req.index}\n${label}`, formatRequestFull(req), cmdNode]
}


export function formatPending(pending, sessions) {
  const items = []
  for (const [sid, reqs] of Object.entries(pending)) {
    for (const [rid, req] of Object.entries(reqs)) items.push([sid, rid, req])
  }
  if (!items.length) return '没有待审批的请求'
  const lines = [`当前待审批 (${items.length} 个):`]
  for (const [sid, rid, req] of items) {
    lines.push('', `[${req.index || 0}] ${sessionLabel(sid, sessions)}`)
    lines.push(`  ${formatRequestDetail(req)}`)
    if (isQuestionRequest(req)) lines.push('  这是 question 请求，请用\n #hapi answer <序号> <答案> 回答')
  }
  lines.push('', '#hapi a 批准全部普通请求')
  lines.push('#hapi allow <序号> 批准单个普通请求')
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
      '#hapi chat <内容>       发消息到当前 session',
      '#hapi chat2 <内容>      发消息到第 2 个 session',
      '#hapi to <序号> <内容>  发消息到指定 session',
      ...quickSendLines,
    ].join('\n'),
    [
      '权限审批',
      '',
      '#hapi pending           查看待审批',
      '#hapi a                 批准全部普通请求',
      '#hapi allow <序号>      批准单个普通请求',
      '#hapi answer <序号> <答案> 回答 question 请求，不是普通聊天',
      '#hapi deny [序号]       拒绝全部或单个请求',
      '戳一戳机器人            批准全部普通请求',
    ].join('\n'),
    [
      'Session 管理',
      '',
      '#hapi machines          查看在线机器',
      '#hapi create <machineId> <目录> <agent> [simple|worktree] [模型] [推理强度] [权限模式] [yolo]',
      '#hapi abort [目标]      中断 session',
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
      '#hapi output [级别]     查看/切换推送级别，不带值会等待下一条消息',
      '#hapi bind [flavor]     设置默认通知窗口',
      '#hapi bind status       查看通知路由',
      '#hapi bind reset        清除当前窗口绑定',
      '#hapi routes            查看通知路由',
      '#hapi更新              更新插件',
      '#hapi强制更新          强制更新插件',
    ].join('\n'),
    createExampleNode(),
  ]
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
