import plugin from '../../../lib/plugins/plugin.js'
import Config from '../components/Config.js'
import State from '../components/State.js'
import { HapiClient } from '../components/HapiClient.js'
import { SseListener } from '../components/SseListener.js'
import * as ops from '../components/SessionOps.js'
import {
  deleteUploadedFile,
  downloadToTmp,
  extractQuotedText,
  extractUploadSources,
  getRemoteFileSize,
  uploadFile,
} from '../components/FileOps.js'
import { smartReply } from '../utils/reply.js'
import { buildMarkdownOutputs, nodesToMarkdown } from '../utils/markdownPic.js'
import { collectGeneratedImagesFromMessages, imageSegmentFromBuffer } from '../utils/generatedImages.js'
import {
  CLAUDE_EFFORTS,
  CODEX_EFFORTS,
  GEMINI_MODEL_MODES,
  MODEL_MODES,
  OPENCODE_EFFORTS,
  PERMISSION_MODES,
  formatDirectory,
  formatFiles,
  formatMessageNodes,
  formatPending,
  formatSessionListNodes,
  formatSessionStatus,
  helpNodes,
  isQuestionRequest,
  sessionLabel,
  sessionLabelWithRuntime,
} from '../utils/formatters.js'

const sessionsCache = []
let sharedClient = null
let sharedSse = null
let booting = null

const UPLOAD_CONCURRENCY = 3

const HAPI_RUNNER_HINT = [
  '没有在线 machine。',
  '请参考 README 安装教程，先在运行 HAPI 的控制台启动 Hapi runner，例如：',
  'hapi runner start --workspace-root /你的项目目录',
  '然后再执行 #hapi machines 或 #hapi create。',
].join('\n')

export class HapiConnector extends plugin {
  constructor() {
    super({
      name: 'hapi-connector',
      dsc: 'HAPI 远程编码会话管理',
      event: 'message',
      priority: 1008,
      rule: [
        {
          reg: /^(\/|#)hapi([\s\S]*)?$/i,
          fnc: 'hapi',
        },
        {
          reg: '^[\\s\\S]+$',
          fnc: 'quickSend',
          log: false,
        },
      ],
    })
    this.config = Config.getConfig()
    sharedClient ||= new HapiClient(this.config)
    this.client = sharedClient
    booting ||= this.bootstrap()
  }

  reply(msg = '', quote = false, data = {}) {
    return smartReply(this.e, msg, quote, data)
  }

  async bootstrap() {
    this.config = Config.getConfig()
    this.client.configure(this.config)
    if (!this.client.isConfigured()) {
      logger.mark('[hapi-connector] 未配置 hapi_endpoint 或 access_token，SSE 暂不启动')
      return
    }
    try {
      sessionsCache.splice(0, sessionsCache.length, ...(await ops.fetchSessions(this.client)))
    } catch (err) {
      logger.warn(`[hapi-connector] 初始化 session 列表失败: ${err.message || err}`)
    }
    if (this.config.enable_sse) {
      sharedSse ||= new SseListener(this.client, sessionsCache, this.pushNotification.bind(this))
      sharedSse.start(this.config)
    }
  }

  async ready(e) {
    State.rememberEvent(e)
    await booting
    this.config = Config.getConfig()
    this.client.configure(this.config)
    if (sharedSse) sharedSse.config = this.config
    if (this.client.isConfigured() && this.config.enable_sse && !sharedSse) {
      sharedSse = new SseListener(this.client, sessionsCache, this.pushNotification.bind(this))
      sharedSse.start(this.config)
    }
    if (!this.client.isConfigured()) {
      await this.reply('请先配置 hapi_connector-plugin/config/config/hapi.yaml 中的 hapi_endpoint 和 access_token')
      return false
    }
    return true
  }

  async refreshSessions() {
    sessionsCache.splice(0, sessionsCache.length, ...(await ops.fetchSessions(this.client)))
    return sessionsCache
  }

  async hapi(e) {
    if (!e.isMaster) return false
    if (!(await this.ready(e))) return true
    const text = String(e.msg || '').replace(/^[/#]hapi/i, '').trim()
    const [cmdRaw = '', ...rest] = splitArgs(text)
    const cmd = cmdRaw.toLowerCase()
    const arg = rest.join(' ')

    if (!cmd || cmd === 'help' || cmd === '帮助') return this.reply(helpNodes(arg, this.config))

    try {
      const chatMatch = cmd.match(/^chat(\d*)$/)
      if (chatMatch) return this.cmdChat(e, arg, chatMatch[1] || '')

      switch (cmd) {
        case 'list':
        case 'ls':
          return this.cmdList(e, arg)
        case 'sw':
          return this.cmdSwitch(e, arg)
        case 's':
        case 'status':
          return this.cmdStatus(e)
        case 'msg':
        case 'messages':
          return this.cmdMessages(e, arg)
        case 'to':
          return this.cmdTo(e, arg)
        case 'pending':
          return this.cmdPending(e)
        case 'a':
        case 'approve':
          return this.cmdApprove(e)
        case 'allow':
          return this.cmdAllow(e, arg)
        case 'answer':
          return this.cmdAnswer(e, arg)
        case 'deny':
          return this.cmdDeny(e, arg)
        case 'machines':
        case 'machine':
          return this.cmdMachines(e)
        case 'create':
          return this.cmdCreate(e, arg)
        case 'abort':
        case 'stop':
          return this.cmdSessionAction(e, arg, ops.abortSession)
        case 'archive':
          return this.cmdSessionAction(e, arg, ops.archiveSession)
        case 'resume':
          return this.cmdResume(e, arg)
        case 'rename':
          return this.cmdRename(e, arg)
        case 'delete':
          return this.cmdDelete(e, arg)
        case 'trim':
          return this.cmdTrim(e, arg)
        case 'clean':
          return this.cmdClean(e, arg)
        case 'remote':
          return this.cmdSessionAction(e, arg, ops.switchToRemote)
        case 'perm':
          return this.cmdPerm(e, arg)
        case 'model':
          return this.cmdModel(e, arg)
        case 'effort':
          return this.cmdEffort(e, arg)
        case 'plan':
          return this.cmdPlan(e)
        case 'output':
        case 'out':
          return this.cmdOutput(e, arg)
        case 'bind':
          return this.cmdBind(e, arg)
        case 'routes':
          return this.cmdRoutes(e)
        case 'files':
        case 'file':
          return this.cmdFiles(e, arg || '.')
        case 'find':
          return this.cmdFind(e, arg)
        case 'download':
        case 'dl':
          return this.cmdDownload(e, arg)
        case 'upload':
          return this.cmdUpload(e, arg)
        case 'read':
          return this.cmdRead(e, arg)
        default:
          return this.reply([`未知命令：#hapi ${cmd}`, ...helpNodes('', this.config)])
      }
    } catch (err) {
      logger.error('[hapi-connector] 命令执行失败', err)
      return this.reply(`执行失败：${err.message || err}`)
    }
  }

  async _sendMessage(sid, text, attachments = []) {
    return ops.sendMessageWithDelayYolo(this.client, sid, text, attachments, {
      delay_yolo_mode: !!this.config?.delay_yolo_mode,
    });
  }

  async quickSend(e) {
    if (!e.isMaster) return false
    this.config = Config.getConfig()
    const msg = String(e.msg || '')
    const rest = quickSendBody(msg, this.config)
    if (rest === null) return false
    if (this.config.quick_group_at_bot_only && isGroupMessage(e) && !isAtSelf(e)) return false
    if (!(await this.ready(e))) return true

    if (!rest) return false
    const attachmentRequest = parseAttachmentRequest(rest)
    if (attachmentRequest) return this.quickSendAttachments(e, attachmentRequest)
    if (/^\d+\s+[\s\S]+$/.test(rest)) return false

    const match = rest.match(/^\{(\d+)\}\s+([\s\S]+)$/)
    if (match) {
      await this.refreshSessions()
      const session = sessionsCache[Number(match[1]) - 1]
      if (!session) return this.reply(`无效序号 ${match[1]}，共 ${sessionsCache.length} 个 session`)
      const [uploadText, attachments] = await this.uploadMessageAttachments(e, session.id)
      const messageText = await this.withQuotedText(e, match[2])
      const [, reply] = await this._sendMessage(session.id, messageText, attachments)
      logger.info(`[hapi-connector] quickSend 触发: ${State.formatWindowKey(State.windowKey(e))} -> ${session.id.slice(0, 8)}`)
      if (uploadText) await this.reply(uploadText)
      return this.reply(reply)
    }

    const sid = State.currentSid(e)
    if (!sid) return this.reply('请先用 #hapi sw <序号> 选择一个 session')
    const [uploadText, attachments] = await this.uploadMessageAttachments(e, sid)
    const messageText = await this.withQuotedText(e, rest)
    const [, reply] = await this._sendMessage(sid, messageText, attachments)
    logger.info(`[hapi-connector] quickSend 触发: ${State.formatWindowKey(State.windowKey(e))} -> ${sid.slice(0, 8)}`)
    if (uploadText) await this.reply(uploadText)
    return this.reply(reply)
  }

  async cmdChat(e, text, index = '') {
    if (!text) return this.reply(`用法：#hapi chat${index || ''} <内容>`)

    let session
    if (index) {
      await this.refreshSessions()
      session = sessionsCache[Number(index) - 1]
      if (!session) return this.reply(`无效序号 ${index}，共 ${sessionsCache.length} 个 session`)
    } else {
      const sid = State.currentSid(e)
      if (!sid) return this.reply('请先用 #hapi sw <序号> 选择一个 session')
      session = { id: sid }
    }

    const [uploadText, attachments] = await this.uploadMessageAttachments(e, session.id)
    const messageText = await this.withQuotedText(e, text)
    const [, reply] = await this._sendMessage(session.id, messageText, attachments)
    logger.info(`[hapi-connector] chat 触发: ${State.formatWindowKey(State.windowKey(e))} -> ${session.id.slice(0, 8)}`)
    if (uploadText) await this.reply(uploadText)
    return this.reply(reply)
  }

  async quickSendAttachments(e, request) {
    const session = await this.resolveQuickTarget(e, request.index)
    if (!session) return true

    const sources = await this.collectAttachmentSources(e, request.count)
    if (!sources) return true

    const [uploadText, attachments] = await this.uploadSources(session.id, sources)
    if (uploadText) await this.reply(uploadText)
    if (!attachments.length) return this.reply('没有成功上传的附件，已取消发送')

    const text = await this.withQuotedText(e, request.text || `请查看这 ${attachments.length} 个附件。`)
    const [, reply] = await this._sendMessage(session.id, text, attachments)
    logger.info(`[hapi-connector] quickSend 附件触发: ${State.formatWindowKey(State.windowKey(e))} -> ${session.id.slice(0, 8)} (${attachments.length})`)
    return this.reply(reply)
  }

  async resolveQuickTarget(e, index = '') {
    if (index) {
      await this.refreshSessions()
      const session = sessionsCache[Number(index) - 1]
      if (!session) {
        await this.reply(`无效序号 ${index}，共 ${sessionsCache.length} 个 session`)
        return null
      }
      return session
    }
    const sid = State.currentSid(e)
    if (!sid) {
      await this.reply('请先用 #hapi sw <序号> 选择一个 session')
      return null
    }
    return { id: sid }
  }

  async collectAttachmentSources(e, count) {
    const sources = []
    const seen = new Set()
    const addSources = async event => {
      const before = sources.length
      for (const source of await extractUploadSources(event)) {
        const key = sourceKey(source)
        if (seen.has(key)) continue
        seen.add(key)
        sources.push(source)
        if (sources.length >= count) break
      }
      return sources.length - before
    }

    await addSources(e)
    while (sources.length < count) {
      await e.reply(`请发送附件，还需要 ${count - sources.length} 个；发送“取消”可退出`, true, { recallMsg: 119 })
      const next = await this.awaitContext()
      if (!next || isCancelText(next.msg)) {
        await e.reply('附件发送已取消', true)
        return null
      }
      const added = await addSources(next)
      if (!added) await e.reply('这条消息里没有识别到图片、视频、文件或语音附件', true)
    }
    return sources.slice(0, count)
  }

  async cmdList(e, arg) {
    if (sharedSse?.hibernated) sharedSse.wakeUp()
    await this.refreshSessions()
    const current = State.currentSid(e)
    if (arg.trim().toLowerCase() === 'all') {
      return this.replySessionList(e, sessionsCache, current)
    }
    const visible = State.visibleSessions(e, sessionsCache).filter(s => s.active || s.thinking)
    return this.replySessionList(e, visible, current, sessionsCache)
  }

  replySessionList(e, sessions, current, allSessions = null) {
    return this.reply(formatSessionListNodes(sessions, current, allSessions, {
      routeLabel: session => State.formatRouteForSession(session, e),
    }))
  }

  async cmdSwitch(e, target) {
    await this.refreshSessions()
    const session = this.resolveSession(target)
    if (!session) return this.reply(`未找到匹配的 session：${target || '(空)'}`)
    State.setCurrent(e, session.id, session.metadata?.flavor || '')
    const meta = session.metadata || {}
    const title = meta.summary?.text || meta.name || ''
    const flavor = meta.flavor || '?'
    const displayText = title ? `[${flavor}] ${session.id.slice(0, 8)} ${title}` : `[${flavor}] ${session.id.slice(0, 8)}`
    return this.reply(`已切换到 ${displayText}\n消息将推送到当前${e.isGroup ? '群' : '私'}聊`)
  }

  async cmdStatus(e) {
    const sid = State.currentSid(e)
    if (!sid) return this.reply('请先用 #hapi sw <序号> 选择一个 session')
    const detail = await ops.fetchSessionDetail(this.client, sid)
    return this.reply(formatSessionStatus(detail))
  }

  async cmdMessages(e, arg) {
    const sid = State.currentSid(e)
    if (!sid) return this.reply('请先用 #hapi sw <序号> 选择一个 session')
    const limit = Math.min(Math.max(Number(arg) || 10, 1), 100)
    let messages
    let detail = null
    if (this.config?.more_session_info) {
      const result = await Promise.all([
        ops.fetchMessages(this.client, sid, limit),
        this.fetchSessionHeaderDetail(sid),
      ])
      messages = result[0]
      detail = result[1]
    } else {
      messages = await ops.fetchMessages(this.client, sid, limit)
    }
    const header = this.config?.more_session_info
      ? sessionLabelWithRuntime(detail || sid, detail ? [detail] : sessionsCache)
      : sessionLabel(sid, sessionsCache)
    const nodes = [header, ...formatMessageNodes(messages)]
    const outs = await buildMarkdownOutputs(this.config?.markdown_output, nodes, nodesToMarkdown(nodes))
    for (const out of outs) await this.reply(out)
    await this.replyGeneratedImages(sid, collectGeneratedImagesFromMessages(messages))
    return
  }

  async cmdTo(e, arg) {
    const parts = splitArgs(arg)
    if (parts.length < 2) return this.reply('用法：#hapi to <序号> <内容>')
    await this.refreshSessions()
    const session = this.resolveSession(parts[0])
    if (!session) return this.reply(`未找到 session：${parts[0]}`)
    const [uploadText, attachments] = await this.uploadMessageAttachments(e, session.id)
    const messageText = await this.withQuotedText(e, arg.slice(parts[0].length).trim())
    const [, msg] = await this._sendMessage(session.id, messageText, attachments)
    if (uploadText) await this.reply(uploadText)
    return this.reply(msg)
  }

  async cmdPending() {
    const pending = sharedSse?.getAllPending() || {}
    return this.reply(formatPending(pending, sessionsCache))
  }

  async cmdApprove() {
    const items = this.flattenPending().filter(item => !isQuestionRequest(item.req))
    if (!items.length) return this.reply('没有可直接批准的普通请求')
    const result = []
    for (const item of items) {
      const [ok, msg] = await ops.approvePermission(this.client, item.sid, item.rid)
      result.push(`${ok ? 'OK' : 'FAIL'} #${item.req.index}: ${msg}`)
    }
    return this.reply(result.join('\n'))
  }

  async cmdAllow(e, arg) {
    const item = this.findPending(arg)
    if (!item) return this.reply('未找到待审批请求')
    if (isQuestionRequest(item.req)) return this.reply('这是 question 请求，请用\n #hapi answer <序号> <答案>')
    const [, msg] = await ops.approvePermission(this.client, item.sid, item.rid)
    return this.reply(msg)
  }

  async cmdAnswer(e, arg) {
    const parts = splitArgs(arg)
    const item = this.findPending(parts[0])
    if (!item) return this.reply('未找到待回答请求')
    const answer = parts.slice(1).join(' ')
    if (!answer) return this.reply('用法：\n #hapi answer <序号> <答案或选项>')
    const answers = { 0: [answer] }
    const [, msg] = await ops.approvePermission(this.client, item.sid, item.rid, answers)
    return this.reply(msg)
  }

  async cmdDeny(e, arg) {
    const items = arg ? [this.findPending(arg)].filter(Boolean) : this.flattenPending()
    if (!items.length) return this.reply('没有待拒绝请求')
    const result = []
    for (const item of items) {
      const [ok, msg] = await ops.denyPermission(this.client, item.sid, item.rid)
      result.push(`${ok ? 'OK' : 'FAIL'} #${item.req.index}: ${msg}`)
    }
    return this.reply(result.join('\n'))
  }

  async cmdMachines() {
    const machines = await ops.fetchMachines(this.client)
    if (!machines.length) return this.reply(HAPI_RUNNER_HINT)
    return this.reply(formatMachineChoices(machines))
  }

  async cmdCreate(e, arg) {
    const parts = splitArgs(arg)
    if (parts.length < 3) return this.cmdCreateWizard(e, parts)
    const [machineId, directory, agent, sessionType = 'simple', yolo = '', reasoning = ''] = parts
    const createOptions = parseCreateOptions(agent, [sessionType, yolo, reasoning, ...parts.slice(6)])
    return this.createSession(e, machineId, directory, agent, createOptions)
  }

  async cmdCreateWizard(e, parts = []) {
    const machines = await ops.fetchMachines(this.client)
    if (!machines.length) return this.reply(HAPI_RUNNER_HINT)

    let machineInput = parts[0] || await this.awaitSettingArg(e, [
      '请选择用于创建 session 的 machine，发送序号或 machineId：',
      '',
      formatMachineChoices(machines),
    ].join('\n'))
    if (!machineInput) return true

    let machine = resolveMachineChoice(machineInput, machines)
    while (!machine) {
      await this.reply(`无效 machine：${machineInput}\n请发送序号或 machineId，发送“取消”退出`)
      machineInput = await this.awaitSettingArg(e, formatMachineChoices(machines))
      if (!machineInput) return true
      machine = resolveMachineChoice(machineInput, machines)
    }

    const directory = parts[1] || await this.selectMachineDirectory(e, machine)
    if (!directory) return true

    const agents = ['claude', 'codex', 'gemini', 'opencode']
    const agent = await this.awaitChoiceArg(e, '请选择 agent：\n1. claude\n2. codex\n3. gemini\n4. opencode', agents, parts[2])
    if (!agent) return true

    const sessionType = await this.awaitChoiceArg(e, '请选择 session 类型：\n1. simple\n2. worktree', ['simple', 'worktree'], parts[3], 'simple')
    if (!sessionType) return true

    const flavor = agent.toLowerCase()
    const selectedMachineId = machineIdOf(machine)
    const createOptions = {
      sessionType,
      yolo: false,
      model: '',
      effort: '',
      permission: '',
    }

    const modelModes = flavor === 'gemini' ? GEMINI_MODEL_MODES : flavor === 'claude' ? MODEL_MODES : []
    if (modelModes.length) {
      const model = await this.awaitChoiceArg(e, `请选择模型，发送“跳过”使用默认：\n${modelModes.map((item, idx) => `${idx + 1}. ${item}`).join('\n')}`, modelModes, '', '')
      if (model === null) return true
      createOptions.model = model
    } else if (['codex', 'opencode'].includes(flavor)) {
      const model = await this.awaitCreateDynamicModel(e, flavor, selectedMachineId, directory)
      if (model === null) return true
      createOptions.model = model
    }

    const efforts = flavor === 'opencode' ? OPENCODE_EFFORTS : flavor === 'codex' ? CODEX_EFFORTS : flavor === 'claude' ? CLAUDE_EFFORTS : []
    if (efforts.length) {
      const labels = efforts.map(item => item || (flavor === 'codex' ? 'inherit' : 'auto'))
      const effort = await this.awaitChoiceArg(e, `请选择推理强度，发送“跳过”使用默认：\n${labels.map((item, idx) => `${idx + 1}. ${item}`).join('\n')}`, labels, '', '')
      if (effort === null) return true
      createOptions.effort = ['inherit', 'auto', 'default'].includes(effort) ? '' : effort
    }

    const permissionModes = PERMISSION_MODES[flavor] || []
    if (permissionModes.length) {
      const permission = await this.awaitChoiceArg(e, `请选择权限模式，发送“跳过”使用默认：\n${permissionModes.map((item, idx) => `${idx + 1}. ${item}`).join('\n')}`, permissionModes, '', '')
      if (permission === null) return true
      createOptions.permission = permission
      if (permission === 'yolo') createOptions.yolo = true
    }

    return this.createSession(e, selectedMachineId, directory, agent, createOptions)
  }

  async createSession(e, machineId, directory, agent, createOptions) {
    const flavor = String(agent || '').toLowerCase()
    const payload = {
      directory,
      agent,
      sessionType: createOptions.sessionType,
      yolo: createOptions.yolo,
    }
    if (createOptions.model && createOptions.model !== 'default') payload.model = createOptions.model
    if (createOptions.effort && ['codex', 'opencode'].includes(flavor)) payload.modelReasoningEffort = createOptions.effort
    if (createOptions.effort && flavor === 'claude') payload.effort = createOptions.effort
    const [ok, msg, sid] = await ops.spawnSession(this.client, machineId, payload)
    await this.reply(msg)
    if (ok && sid) {
      State.setCurrent(e, sid, agent)
      await this.refreshSessions()
      await this.applyCreateOptions(sid, agent, createOptions)
    }
    return true
  }

  async selectMachineDirectory(e, machine) {
    const machineId = machineIdOf(machine)
    const roots = machineWorkspaceRoots(machine)
    let current = roots.length > 1 ? '' : machineDefaultPath(machine)

    while (true) {
      if (!current && roots.length > 1) {
        const input = await this.awaitSettingArg(e, [
          '请选择远端工作目录根目录：',
          roots.map((root, idx) => `${idx + 1}. ${root}`).join('\n'),
          '',
          '发送序号直接选择根目录，发送“cd 序号”进入该根目录；也可以直接输入完整路径。',
        ].join('\n'))
        if (!input) return ''
        const text = input.trim()
        const cdMatch = text.match(/^cd\s+(\d+)$/i)
        if (cdMatch) {
          const root = roots[Number(cdMatch[1]) - 1]
          if (!root) {
            await this.reply(`无效目录序号：${cdMatch[1]}`)
            continue
          }
          current = root
          continue
        }
        if (/^\d+$/.test(text) && roots[Number(text) - 1]) return roots[Number(text) - 1]
        return text
      }

      let dirs = []
      let listError = ''
      try {
        const entries = await ops.listMachineDirectory(this.client, machineId, current)
        dirs = entries.filter(isDirectoryEntry).slice(0, 30)
      } catch (err) {
        listError = err.message || String(err)
      }

      const prompt = listError
        ? [
          `无法从 HAPI runner 获取目录列表：${listError}`,
          '请直接输入远端工作目录，例如：/root/TRSS-Yunzai 或 E:/myrepo/project',
        ].join('\n')
        : [
          `请选择远端工作目录，当前浏览：${current}`,
          dirs.length ? dirs.map((item, idx) => `${idx + 1}. ${directoryEntryName(item)}`).join('\n') : '(当前目录下没有可显示的子目录)',
          '',
          roots.length > 1
            ? '发送“.”选择当前目录，发送序号选择子目录，发送“cd 序号”进入子目录，发送“..”返回上级，发送“roots”返回根目录列表；也可以直接输入完整路径。'
            : '发送“.”选择当前目录，发送序号选择子目录，发送“cd 序号”进入子目录，发送“..”返回上级；也可以直接输入完整路径。',
        ].join('\n')

      const input = await this.awaitSettingArg(e, prompt)
      if (!input) return ''
      const text = input.trim()
      const lower = text.toLowerCase()
      if (roots.length > 1 && ['root', 'roots'].includes(lower)) {
        current = ''
        continue
      }
      if (text === '.') return current
      if (lower === '..') {
        const parent = parentPath(current)
        current = roots.length && !isPathWithinRoots(parent, roots)
          ? roots.length > 1 ? '' : roots[0]
          : parent
        continue
      }
      const cdMatch = text.match(/^cd\s+(\d+)$/i)
      if (cdMatch) {
        const dir = dirs[Number(cdMatch[1]) - 1]
        if (!dir) {
          await this.reply(`无效目录序号：${cdMatch[1]}`)
          continue
        }
        current = directoryEntryPath(dir, current)
        continue
      }
      if (/^\d+$/.test(text) && dirs[Number(text) - 1]) return directoryEntryPath(dirs[Number(text) - 1], current)
      return text
    }
  }

  async awaitChoiceArg(e, prompt, values, initial = '', fallback = null) {
    while (true) {
      const input = String(initial || '').trim() || await this.awaitSettingArg(e, prompt)
      initial = ''
      if (!input) return null
      if (fallback !== null && isSkipText(input)) return fallback
      const target = resolveChoice(input, values, { model: true })
      if (values.includes(target)) return target
      await this.reply(`无效输入：${input}\n可用: ${values.join(', ')}${fallback !== null ? '\n发送“跳过”使用默认值。' : ''}`)
    }
  }

  async awaitCreateDynamicModel(e, flavor, machineId, directory) {
    const isCodex = flavor === 'codex'
    const label = isCodex ? 'Codex' : 'OpenCode'
    const idLabel = isCodex ? 'model id' : 'modelId'
    const normalize = isCodex ? normalizeCodexModels : normalizeOpencodeModels
    const format = isCodex ? formatCodexModelChoices : formatOpencodeModelChoices
    const resolve = isCodex ? resolveCodexModelChoice : resolveOpencodeModelChoice

    let models = []
    let error = ''
    try {
      const data = isCodex
        ? await ops.fetchMachineCodexModels(this.client, machineId)
        : await ops.fetchMachineOpencodeModels(this.client, machineId, directory)
      if (data?.success) {
        models = normalize(isCodex ? data.models : data.availableModels)
      } else {
        error = data?.error || '未知错误'
      }
    } catch (err) {
      error = err.message || String(err)
    }

    const choices = models.length ? format(models) : ''
    const prompt = models.length
      ? `请选择 ${label} 模型，发送“跳过”使用默认：\n${choices}`
      : [
          `获取 ${label} 模型列表失败: ${error || '未返回可用模型'}`,
          `可直接发送完整 ${idLabel}，或发送“跳过”使用默认：`,
        ].join('\n')

    while (true) {
      const input = await this.awaitSettingArg(e, prompt)
      if (!input) return null
      if (isSkipText(input)) return ''

      if (!models.length) return input

      const target = resolve(input, models)
      if (target) return target
      await this.reply(`无效模型：${input}\n可用:\n${choices}\n发送“跳过”使用默认值。`)
    }
  }

  async applyCreateOptions(sid, agent, options) {
    if (!options.permission || ['default', 'yolo'].includes(options.permission)) return

    const [ok, msg] = await retrySessionConfig(() => ops.setPermissionMode(this.client, sid, options.permission))
    if (!ok || msg) await this.reply(msg)
  }

  async cmdSessionAction(e, arg, action) {
    await this.refreshSessions()
    const sid = this.resolveSession(arg)?.id || State.currentSid(e)
    if (!sid) return this.reply('请先选择 session，或提供序号/ID前缀')
    const [ok, msg] = await action(this.client, sid)
    if (ok) await this.refreshSessions()
    return this.reply(msg)
  }

  async cmdResume(e, arg) {
    await this.refreshSessions()
    const sid = this.resolveSession(arg)?.id || State.currentSid(e)
    if (!sid) return this.reply('请先选择 session，或提供序号/ID前缀')
    const [ok, msg, newSid] = await ops.resumeSession(this.client, sid)
    if (ok && newSid) {
      const old = sessionsCache.find(item => item.id === sid)
      State.setCurrent(e, newSid, old?.metadata?.flavor || '')
      await this.refreshSessions()
    }
    return this.reply(msg)
  }

  async cmdDelete(e, arg) {
    await this.refreshSessions()
    const sid = this.resolveSession(arg)?.id || State.currentSid(e)
    if (!sid) return this.reply('请先选择 session，或提供序号/ID前缀')
    const [ok, msg] = await ops.deleteSession(this.client, sid)
    if (ok) {
      State.clearSession(sid)
      await this.refreshSessions()
    }
    return this.reply(msg)
  }

  async cmdTrim(e, arg) {
    await this.refreshSessions()
    const n = parseInt(arg)
    if (!n || n <= 0) {
      // 没有给出有效数量时，用合并转发分节点展示已关闭会话和用法说明
      const inactiveSessions = sessionsCache.filter(session => !session.active)
      if (!inactiveSessions.length) {
        return this.reply('没有已关闭的会话\n\n用法：#hapi trim <数量>\n删除倒数的 N 个已关闭会话')
      }
      const total = inactiveSessions.length
      const nodes = [
        `用法：#hapi trim <数量>\n删除倒数的 N 个已关闭会话\n\n当前共 ${total} 个已关闭会话：`,
        ...inactiveSessions.map((session, idx) => {
          const meta = session.metadata || {}
          const title = meta.summary?.text || meta.name || '(无标题)'
          const path = meta.path || '(无路径)'
          const status = session.thinking ? '思考中' : session.active ? '运行中' : '已关闭'
          return [
            `目录: ${path}`,
            `[倒数第 ${total - idx} | ${session.id.slice(0, 8)}] ${title}`,
            `${status} | ${meta.flavor || '?'}:${session.modelMode || 'default'}`,
          ].join('\n')
        }),
        '发送 #hapi trim <数量> 即可删除「倒数第 1 ~ N」个已关闭会话。',
      ]
      return this.reply(nodes)
    }

    // 获取所有已关闭的会话
    const inactiveSessions = sessionsCache.filter(session => !session.active)
    if (!inactiveSessions.length) return this.reply('没有已关闭的会话')

    // 取倒数 N 个
    const toDelete = inactiveSessions.slice(-Math.min(n, inactiveSessions.length))
    if (!toDelete.length) return this.reply('没有符合条件的会话')

    // 构建合并转发节点
    const bot = e.bot ?? Bot
    let nickname = bot.nickname || 'HAPI Connector'
    if (e.isGroup) {
      let info = null
      try {
        if (bot.getGroupMemberInfo) info = await bot.getGroupMemberInfo(e.group_id, bot.uin)
        else if (bot.pickMember) info = await bot.pickMember(e.group_id, bot.uin)
      } catch { }
      nickname = info?.card || info?.nickname || nickname
    }
    const userInfo = { user_id: bot.uin, nickname }

    // 创建会话列表节点
    const nodes = [{ ...userInfo, message: `即将删除以下 ${toDelete.length} 个已关闭的会话：` }]

    for (const session of toDelete) {
      const meta = session.metadata || {}
      const title = meta.summary?.text || meta.name || '(无标题)'
      const path = meta.path || '(无路径)'
      const flavor = meta.flavor || '?'
      const model = session.modelMode || 'default'
      const nodeText = [
        `[${session.id.slice(0, 8)}] ${title}`,
        `路径: ${path}`,
        `${flavor}:${model}`,
      ].join('\n')
      nodes.push({ ...userInfo, message: nodeText })
    }

    nodes.push({ ...userInfo, message: '请在 120 秒内发送"确认"或"yes"来删除这些会话\n发送"取消"退出' })

    // 发送合并转发
    let forwardMsg
    if (e.group?.makeForwardMsg) forwardMsg = await e.group.makeForwardMsg(nodes)
    else if (e.friend?.makeForwardMsg) forwardMsg = await e.friend.makeForwardMsg(nodes)

    if (forwardMsg) {
      await e.reply(forwardMsg)
    } else {
      // 降级为普通文本
      const text = nodes.map(node => node.message).join('\n\n')
      await this.reply(text)
    }

    // 等待用户确认
    const next = await this.awaitContext()
    if (!next) return this.reply('操作超时，已取消')

    const response = String(next.msg || '').trim().toLowerCase()
    if (!['确认', 'yes', 'y', '是'].includes(response)) {
      return this.reply('操作已取消', true)
    }

    // 执行删除
    let okCount = 0
    const lines = []
    for (const session of toDelete) {
      const [ok, msg] = await ops.deleteSession(this.client, session.id)
      if (ok) {
        okCount += 1
        State.clearSession(session.id)
      }
      lines.push(msg)
    }
    await this.refreshSessions()
    return this.reply(`删除完成: ${okCount}/${toDelete.length}\n${lines.join('\n')}`)
  }

  async cmdRename(e, arg) {
    const sid = State.currentSid(e)
    if (!sid) return this.reply('请先选择 session')
    const name = arg.trim()
    if (!name) return this.reply('用法：#hapi rename <新标题>')
    const [, msg] = await ops.renameSession(this.client, sid, name)
    await this.refreshSessions()
    return this.reply(msg)
  }

  async cmdClean(e, arg) {
    await this.refreshSessions()
    const pathFilter = splitArgs(arg)
      .filter(item => !['confirm', 'yes', '确认'].includes(item.toLowerCase()))
      .join(' ')
    const targets = sessionsCache.filter(session => {
      if (session.active) return false
      if (!pathFilter) return true
      return String(session.metadata?.path || '').startsWith(pathFilter)
    })
    if (!targets.length) return this.reply('没有符合条件的已关闭会话')

    // 像 #hapi list all 一样，用合并转发分节点展示每个会话（含状态）
    const nodes = [
      `共 ${targets.length} 个已关闭会话，请选择要删除的会话：`,
      ...targets.map((session, idx) => {
        const meta = session.metadata || {}
        const title = meta.summary?.text || meta.name || '(无标题)'
        const path = meta.path || '(无路径)'
        const status = session.thinking ? '思考中' : session.active ? '运行中' : '已关闭'
        return [
          `目录: ${path}`,
          `[${idx + 1} | ${session.id.slice(0, 8)}] ${title}`,
          `${status} | ${meta.flavor || '?'}:${session.modelMode || 'default'}`,
        ].join('\n')
      }),
      '发送序号选择（多个用空格或逗号分隔，支持区间如 1-3），发送“all”删除全部，发送“取消”退出。',
    ]

    const input = await this.awaitSettingArg(e, nodes)
    if (!input) return true

    const selected = parseSessionSelection(input, targets.length).map(idx => targets[idx])
    if (!selected.length) return this.reply('未识别到有效序号，已取消')

    let okCount = 0
    const lines = []
    for (const session of selected) {
      const [ok, msg] = await ops.deleteSession(this.client, session.id)
      if (ok) {
        okCount += 1
        State.clearSession(session.id)
      }
      lines.push(msg)
    }
    await this.refreshSessions()
    return this.reply(`删除完成: ${okCount}/${selected.length}\n${lines.join('\n')}`)
  }

  async cmdPerm(e, arg) {
    const sid = State.currentSid(e)
    if (!sid) return this.reply('请先选择 session')
    const detail = await ops.fetchSessionDetail(this.client, sid)
    const flavor = detail.metadata?.flavor || State.currentFlavor(e) || 'claude'
    const modes = PERMISSION_MODES[flavor] || ['default']
    if (!arg) {
      arg = await this.awaitSettingArg(e, `当前权限模式: ${detail.permissionMode || 'default'}\n可用: ${modes.join(', ')}\n请在 120 秒内发送要切换的权限模式，发送“取消”退出`)
      if (!arg) return true
    }
    const target = resolveChoice(arg, modes)
    if (!modes.includes(target)) return this.reply(`无效模式：${arg}\n可用: ${modes.join(', ')}`)
    const [, msg] = await ops.setPermissionMode(this.client, sid, target)
    return this.reply(msg)
  }

  async cmdModel(e, arg) {
    const sid = State.currentSid(e)
    if (!sid) return this.reply('请先选择 session')
    const detail = await ops.fetchSessionDetail(this.client, sid)
    const flavor = detail.metadata?.flavor || 'claude'
    if (flavor === 'codex') {
      let data
      try {
        data = await ops.fetchCodexModels(this.client, sid)
      } catch (err) {
        return this.reply(`获取 Codex 模型失败: ${err.message || err}`)
      }
      if (!data?.success) return this.reply(`获取 Codex 模型失败: ${data?.error || '未知错误'}`)

      const models = normalizeCodexModels(data.models)
      if (!models.length) return this.reply('Codex 未返回可用模型列表')

      const choices = formatCodexModelChoices(models)
      const currentModel = detail.modelMode || models.find(model => model.isDefault)?.id || 'default'
      if (!arg) {
        arg = await this.awaitSettingArg(e, `当前模型: ${currentModel}\n可用:\n${choices}\n请在 120 秒内发送要切换的模型编号或完整 modelId，发送“取消”退出`)
        if (!arg) return true
      }

      const target = resolveCodexModelChoice(arg, models)
      if (!target) return this.reply(`无效模型：${arg}\n可用:\n${choices}`)
      const [, msg] = await ops.setModelMode(this.client, sid, target)
      return this.reply(msg)
    }

    if (flavor === 'opencode') {
      let data
      try {
        data = await ops.fetchOpencodeModels(this.client, sid)
      } catch (err) {
        return this.reply(`获取 OpenCode 模型失败: ${err.message || err}`)
      }
      if (!data?.success) return this.reply(`获取 OpenCode 模型失败: ${data?.error || '未知错误'}`)

      const models = normalizeOpencodeModels(data.availableModels)
      if (!models.length) return this.reply('OpenCode 未返回可用模型列表')

      const choices = formatOpencodeModelChoices(models)
      const currentModel = data.currentModelId || detail.modelMode || 'default'
      if (!arg) {
        arg = await this.awaitSettingArg(e, `当前模型: ${currentModel}\n可用:\n${choices}\n请在 120 秒内发送要切换的模型编号或完整 modelId，发送“取消”退出`)
        if (!arg) return true
      }

      const target = resolveOpencodeModelChoice(arg, models)
      if (!target) return this.reply(`无效模型：${arg}\n可用:\n${choices}`)
      const [, msg] = await ops.setModelMode(this.client, sid, target)
      return this.reply(msg)
    }

    const modes = flavor === 'gemini' ? GEMINI_MODEL_MODES : MODEL_MODES
    if (!['claude', 'gemini'].includes(flavor)) return this.reply('模型切换仅支持 Claude / Gemini / Codex / OpenCode session')
    if (!arg) {
      arg = await this.awaitSettingArg(e, `当前模型: ${detail.modelMode || 'default'}\n可用: ${modes.join(', ')}\n请在 120 秒内发送要切换的模型，发送“取消”退出`)
      if (!arg) return true
    }
    const target = resolveChoice(arg, modes, { model: true })
    if (!modes.includes(target)) return this.reply(`无效模型：${arg}\n可用: ${modes.join(', ')}`)
    const [, msg] = await ops.setModelMode(this.client, sid, target)
    return this.reply(msg)
  }

  async cmdEffort(e, arg) {
    const sid = State.currentSid(e)
    if (!sid) return this.reply('请先选择 session')
    const detail = await ops.fetchSessionDetail(this.client, sid)
    const flavor = detail.metadata?.flavor || 'claude'
    if (!['claude', 'codex'].includes(flavor)) return this.reply('推理强度仅支持 Claude / Codex session')
    const values = flavor === 'codex' ? CODEX_EFFORTS : CLAUDE_EFFORTS
    const labels = values.map(item => item || (flavor === 'codex' ? 'inherit' : 'auto'))
    if (!arg) {
      arg = await this.awaitSettingArg(e, `可用推理强度: ${labels.join(', ')}\n请在 120 秒内发送要切换的值，发送“取消”退出`)
      if (!arg) return true
    }
    const lowerArg = String(arg || '').trim().toLowerCase()
    const normalized = ['inherit', 'auto', 'default'].includes(lowerArg) ? '' : lowerArg
    if (!values.includes(normalized)) return this.reply(`无效值：${arg}`)
    const [, msg] = await ops.setEffort(this.client, sid, normalized, flavor)
    return this.reply(msg)
  }

  async awaitSettingArg(e, prompt) {
    await this.reply(prompt)
    const next = await this.awaitContext()
    if (!next) return ''
    const text = String(next.msg || '').trim()
    if (isCancelText(text)) {
      await this.reply('操作已取消', true)
      return ''
    }
    return text
  }

  async cmdPlan(e) {
    const sid = State.currentSid(e)
    if (!sid) return this.reply('请先选择 session')
    const detail = await ops.fetchSessionDetail(this.client, sid)
    const flavor = detail.metadata?.flavor || 'claude'
    if (flavor === 'codex') {
      const next = detail.collaborationMode === 'plan' ? 'default' : 'plan'
      const [, msg] = await ops.setCollaborationMode(this.client, sid, next)
      return this.reply(msg)
    }
    if (['claude', 'opencode'].includes(flavor)) {
      const next = detail.permissionMode === 'plan' ? 'default' : 'plan'
      const [, msg] = await ops.setPermissionMode(this.client, sid, next)
      return this.reply(msg)
    }
    return this.reply('Plan 模式仅支持 Claude / Codex / OpenCode session')
  }

  async cmdOutput(e, arg) {
    const levels = ['silence', 'simple', 'summary', 'detail']
    if (!arg) {
      arg = await this.awaitSettingArg(e, `当前推送级别: ${this.config.output_level}\n可用: ${levels.join(', ')}\n请在 120 秒内发送要切换的推送级别，发送“取消”退出`)
      if (!arg) return true
    }
    const target = resolveChoice(arg, levels)
    if (!levels.includes(target)) return this.reply(`无效级别：${arg}\n可用: ${levels.join(', ')}`)
    Config.updateConfig('output_level', target)
    sharedSse?.start(Config.getConfig())
    return this.reply(`推送级别已切换为: ${target}`)
  }

  async cmdBind(e, arg) {
    const parts = splitArgs(arg)
    const action = (parts[0] || '').toLowerCase()
    const cleanTarget = (parts[1] || '').toLowerCase()
    if (!action) {
      return this.reply('用法：#hapi bind <claude|codex|gemini|opencode|all|status|reset> / #hapi bind clean <all|claude|codex|gemini|opencode>')
    }
    if (action === 'all') {
      State.bindPrimary(e)
      return this.reply('已设置当前聊天为默认通知窗口\n所有未绑定的Hapi session都将推送到此窗口')
    }
    if (['claude', 'codex', 'gemini', 'opencode'].includes(action)) {
      State.bindPrimary(e, action)
      return this.reply(`已设置当前聊天为 ${action} 默认通知窗口`)
    }
    if (action === 'reset') {
      State.resetBindings(e)
      return this.reply('已清空当前窗口的 session 绑定和窗口状态')
    }
    if (action === 'clean') {
      const flavors = ['claude', 'codex', 'gemini', 'opencode']
      if (!cleanTarget || parts.length > 2 || !['all', ...flavors].includes(cleanTarget)) {
        return this.reply('用法：#hapi bind clean <all|claude|codex|gemini|opencode>')
      }
      if (cleanTarget === 'all') {
        State.cleanDefaultBindings(e)
        return this.reply('已清除当前用户的所有默认通知窗口配置')
      }
      State.cleanFlavorBinding(e, cleanTarget)
      return this.reply(`已清除当前用户的 ${cleanTarget} 默认通知窗口配置`)
    }
    if (action === 'status') return this.cmdRoutes(e)
    return this.reply('用法：#hapi bind <claude|codex|gemini|opencode|all|status|reset> / #hapi bind clean <all|claude|codex|gemini|opencode>')
  }

  async cmdRoutes(e) {
    await this.refreshSessions()
    const lines = ['HAPI 通知路由:']
    for (const session of sessionsCache) {
      lines.push(`${session.id.slice(0, 8)} ${session.metadata?.flavor || '?'} -> ${State.formatRouteForSession(session, e)}`)
    }
    return this.reply(lines.join('\n'))
  }

  async cmdFiles(e, arg) {
    const sid = State.currentSid(e)
    if (!sid) return this.reply('请先选择 session')
    const parts = splitArgs(arg)
    const detail = parts.includes('-l')
    const targetPath = parts.filter(item => item !== '-l').join(' ') || '.'
    const entries = await ops.listDirectory(this.client, sid, targetPath)
    return this.reply(formatDirectory(entries, targetPath, detail))
  }

  async cmdFind(e, arg) {
    const sid = State.currentSid(e)
    if (!sid) return this.reply('请先选择 session')
    if (!arg) return this.reply('用法：#hapi find <关键词>')
    const files = await ops.listFiles(this.client, sid, arg)
    return this.reply(formatFiles(files, arg))
  }

  async cmdRead(e, arg) {
    const sid = State.currentSid(e)
    if (!sid) return this.reply('请先选择 session')
    if (!arg) return this.reply('用法：#hapi read <远端文件路径>')
    const [ok, content] = await ops.readFile(this.client, sid, arg)
    if (!ok) return this.reply(content)
    const decoded = Buffer.from(content, 'base64').toString('utf8')
    return this.reply(splitLong(decoded || '(空文件)'))
  }

  async cmdDownload(e, arg) {
    const sid = State.currentSid(e)
    if (!sid) return this.reply('请先选择 session')
    const remotePath = arg.trim()
    if (!remotePath) return this.reply('用法：#hapi download <远端文件路径>')
    const size = await getRemoteFileSize(this.client, sid, remotePath)
    if (size > 10 * 1024 * 1024) return this.reply(`文件过大 (${(size / 1024 / 1024).toFixed(1)} MB)，超过 10 MB 限制`)

    let file
    try {
      file = await downloadToTmp(this.client, sid, remotePath)
      if (file.isImage) {
        await e.reply(segment.image(file.tmpPath))
      } else if (e.group?.sendFile) {
        await e.group.sendFile(file.tmpPath, file.filename)
      } else if (e.friend?.sendFile) {
        await e.friend.sendFile(file.tmpPath, file.filename)
      } else if (e.bot?.sendFile) {
        await e.bot.sendFile(file.tmpPath, file.filename)
      } else {
        await e.reply(segment.file(file.tmpPath, file.filename))
      }
      return true
    } catch (err) {
      return this.reply(`下载失败：${err.message || err}`)
    } finally {
      if (file?.tmpPath) {
        const fs = await import('node:fs')
        fs.rmSync(file.tmpPath, { force: true })
      }
    }
  }

  async cmdUpload(e, arg) {
    const sid = State.currentSid(e)
    if (!sid) return this.reply('请先选择 session')
    const action = arg.trim().toLowerCase()
    if (action === 'cancel') {
      const entries = await ops.listDirectory(this.client, sid, '/blobs')
      const files = entries.filter(item => item.type === 'file')
      if (!files.length) return this.reply('当前 session 没有已上传的文件')
      const lines = []
      for (const file of files) {
        const [, msg] = await deleteUploadedFile(this.client, sid, `/blobs/${file.name}`)
        lines.push(msg)
      }
      return this.reply(lines.join('\n'))
    }

    const sources = await extractUploadSources(e)
    if (!sources.length) return this.reply('请在同一条消息里附带图片或文件：#hapi upload [附件]')
    const [uploadText, attachments] = await this.uploadSources(sid, sources)
    return this.reply(`${uploadText}\n\n已上传 ${attachments.length}/${sources.length} 个附件到 [${sid.slice(0, 8)}]`)
  }

  resolveSession(target) {
    const text = String(target || '').trim()
    if (!text) return null
    if (/^\d+$/.test(text)) return sessionsCache[Number(text) - 1] || null
    const matches = sessionsCache.filter(item => item.id?.startsWith(text))
    return matches.length === 1 ? matches[0] : null
  }

  flattenPending() {
    const pending = sharedSse?.getAllPending() || {}
    const items = []
    for (const [sid, reqs] of Object.entries(pending)) {
      for (const [rid, req] of Object.entries(reqs)) items.push({ sid, rid, req })
    }
    return items
  }

  findPending(index) {
    const idx = Number(String(index || '').trim())
    if (!idx) return null
    return this.flattenPending().find(item => Number(item.req.index) === idx) || null
  }

  async pushNotification(text, sid) {
    const session = sid ? sessionsCache.find(item => item.id === sid) : null
    const key = session ? State.windowForSession(session) : [...State.eventCache.keys()][0]
    if (!key) return
    const msg = splitLong(text)
    const event = await buildEventFromWindowKey(key)
    if (event?.reply) {
      try {
        await smartReply(event, msg)
        return
      } catch (err) {
        logger.warn(`[hapi-connector] 重建事件 reply 失败，尝试缓存事件: ${err.message || err}`)
      }
    }
    const cachedEvent = State.eventCache.get(key)
    if (cachedEvent?.reply) {
      try {
        await smartReply(cachedEvent, msg)
        return
      } catch (err) {
        logger.warn(`[hapi-connector] 缓存事件 reply 失败，尝试直接发送: ${err.message || err}`)
      }
    }
    await sendByWindowKey(key, msg)
  }

  async uploadMessageAttachments(e, sid) {
    const sources = await extractUploadSources(e)
    if (!sources.length) return ['', []]
    return this.uploadSources(sid, sources)
  }

  async uploadSources(sid, sources) {
    const results = await mapLimit(sources, UPLOAD_CONCURRENCY, source => uploadFile(this.client, sid, source))
    const lines = []
    const attachments = []
    for (const [ok, msg, attachment] of results) {
      lines.push(msg)
      if (ok && attachment) attachments.push(attachment)
    }
    return [lines.join('\n'), attachments]
  }

  async withQuotedText(e, text) {
    const quotedText = await extractQuotedText(e)
    if (!quotedText) return text
    const message = String(text || '')
    return message.startsWith(quotedText) ? message : `${quotedText}\n\n${message}`
  }

  async replyGeneratedImages(sid, images) {
    for (const img of images || []) {
      const buffer = await ops.fetchGeneratedImage(this.client, sid, img.imageId)
      if (buffer) {
        await this.reply(imageSegmentFromBuffer(buffer, img))
      } else {
        logger.warn(`[hapi-connector] 无法获取图片: ${img.imageId}`)
      }
    }
  }

  async fetchSessionHeaderDetail(sid) {
    try {
      return await ops.fetchSessionDetail(this.client, sid)
    } catch (err) {
      logger.warn(`[hapi-connector] 获取 session 详情失败: ${err.message || err}`)
      return sessionsCache.find(item => item.id === sid) || null
    }
  }

}

export function getHapiRuntime() {
  return {
    client: sharedClient,
    sse: sharedSse,
    sessions: sessionsCache,
  }
}

function splitArgs(text) {
  const result = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match
  while ((match = re.exec(text))) result.push(match[1] ?? match[2] ?? match[3])
  return result
}

// 解析用户对编号列表的选择，返回去重排序后的 0-based 下标数组
// 支持：单个序号、空格/逗号/顿号分隔的多选、区间（如 1-3）、以及 all/全部
function parseSessionSelection(input, count) {
  const text = String(input || '').trim().toLowerCase()
  if (['all', '全部', '所有', '*'].includes(text)) {
    return Array.from({ length: count }, (_, idx) => idx)
  }
  const indices = new Set()
  const normalized = text.replace(/\s*([-~])\s*/g, '$1')
  for (const token of normalized.split(/[\s,，、]+/).filter(Boolean)) {
    const range = token.match(/^(\d+)[-~](\d+)$/)
    if (range) {
      let [from, to] = [Number(range[1]), Number(range[2])]
      if (from > to) [from, to] = [to, from]
      for (let n = from; n <= to; n++) if (n >= 1 && n <= count) indices.add(n - 1)
    } else if (/^\d+$/.test(token)) {
      const n = Number(token)
      if (n >= 1 && n <= count) indices.add(n - 1)
    }
  }
  return [...indices].sort((a, b) => a - b)
}

function splitLong(text, size = 3500) {
  if (typeof text !== 'string' || text.length <= size) return text
  const parts = []
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size))
  return parts
}

async function retrySessionConfig(action, attempts = 8) {
  let last = [false, '']
  for (let i = 0; i < attempts; i++) {
    last = await action()
    if (last[0] || !isSessionRpcPending(last[1])) return last
    await sleep(1000)
  }
  return last
}

function isSessionRpcPending(msg = '') {
  return /RPC handler not registered|set-session-config/i.test(String(msg))
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function quickSendBody(msg, config = {}) {
  if (config.quick_send_enabled === false) return null
  const prefix = config.quick_prefix === undefined || config.quick_prefix === null
    ? '>'
    : String(config.quick_prefix)
  if (!prefix) return null
  if (msg.startsWith(prefix)) return msg.slice(prefix.length).trim()
  if (prefix === '>' && msg.startsWith('＞')) return msg.slice(1).trim()
  return null
}

function parseAttachmentRequest(text) {
  const match = String(text || '').match(/^(?:\{(\d+)\}\s*)?上传附件\s*(\d+)?\s*(?:张|份|个|件|条|段|则)?(?:\s+([\s\S]+))?$/)
  if (!match) return null
  const count = Math.min(Math.max(Number(match[2]) || 1, 1), 20)
  return {
    index: match[1] || '',
    count,
    text: (match[3] || '').trim(),
  }
}

function isCancelText(text) {
  return ['0', '取消', '退出', 'cancel', 'q'].includes(String(text || '').trim().toLowerCase())
}

function isGroupMessage(e) {
  return Boolean(e?.isGroup || e?.message_type === 'group' || e?.group_id)
}

function isAtSelf(e) {
  const selfId = String(e?.self_id || e?.bot?.uin || '')
  if (!selfId) return false
  const atTargets = []
  if (Array.isArray(e?.at)) atTargets.push(...e.at)
  else if (e?.at !== undefined && e?.at !== null) atTargets.push(e.at)
  if (Array.isArray(e?.message)) {
    for (const item of e.message) {
      if (item?.type !== 'at') continue
      const target = item.qq ?? item.data?.qq ?? item.user_id ?? item.id
      if (target !== undefined && target !== null) atTargets.push(target)
    }
  }
  return atTargets.some(target => String(target) === selfId)
}

function isSkipText(text) {
  return ['跳过', '默认', 'default', 'skip', 'none', '无'].includes(String(text || '').trim().toLowerCase())
}

function resolveChoice(input, values, options = {}) {
  const raw = String(input || '').trim()
  if (/^\d+$/.test(raw)) return values[Number(raw) - 1]
  const normalized = options.model ? normalizeModelInput(raw) : raw
  return values.find(item => item.toLowerCase() === normalized.toLowerCase()) ?? normalized
}

function normalizeCodexModels(models) {
  if (!Array.isArray(models)) return []
  const seen = new Set()
  const out = []
  for (const item of models) {
    const id = String(item?.id || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const displayName = String(item?.displayName || '').trim()
    out.push({
      id,
      displayName: displayName && displayName !== id ? displayName : '',
      isDefault: item?.isDefault === true,
    })
  }
  return out
}

function formatCodexModelChoices(models) {
  return models.map((model, idx) => {
    const label = model.displayName ? `${model.displayName} (${model.id})` : model.id
    const suffix = model.isDefault ? ' [default]' : ''
    return `${idx + 1}. ${label}${suffix}`
  }).join('\n')
}

function resolveCodexModelChoice(input, models) {
  const raw = String(input || '').trim()
  if (/^\d+$/.test(raw)) return models[Number(raw) - 1]?.id || ''
  return models.find(model => model.id === raw)?.id || ''
}

function normalizeOpencodeModels(models) {
  if (!Array.isArray(models)) return []
  const seen = new Set()
  const out = []
  for (const item of models) {
    const modelId = String(item?.modelId || '').trim()
    if (!modelId || seen.has(modelId)) continue
    seen.add(modelId)
    const name = String(item?.name || '').trim()
    out.push(name && name !== modelId ? { modelId, name } : { modelId })
  }
  return out
}

function formatOpencodeModelChoices(models) {
  return models.map((model, idx) => {
    const label = model.name ? `${model.name} (${model.modelId})` : model.modelId
    return `${idx + 1}. ${label}`
  }).join('\n')
}

function resolveOpencodeModelChoice(input, models) {
  const raw = String(input || '').trim()
  if (/^\d+$/.test(raw)) return models[Number(raw) - 1]?.modelId || ''
  return models.find(model => model.modelId === raw)?.modelId || ''
}

function formatMachineChoices(machines) {
  return machines.map((machine, idx) => {
    const id = machineIdOf(machine)
    const name = machine.name && machine.name !== id ? `\n${machine.name}` : ''
    const roots = machineWorkspaceRoots(machine)
    const rootText = roots.length
      ? `\n工作目录:\n${roots.map((root, rootIdx) => `  ${rootIdx + 1}. ${root}`).join('\n')}`
      : ''
    return `[${idx + 1}] ${id}${name}${rootText}`
  }).join('\n\n')
}

function resolveMachineChoice(input, machines) {
  const raw = String(input || '').trim()
  if (/^\d+$/.test(raw)) return machines[Number(raw) - 1] || null
  return machines.find(machine => machineIdOf(machine).toLowerCase() === raw.toLowerCase()) || null
}

function machineIdOf(machine) {
  return String(machine?.id || machine?.machineId || machine?.name || '')
}

function machineWorkspaceRoots(machine) {
  const meta = machine?.metadata || machine?.data || machine || {}
  const roots = []
  for (const key of ['workspaceRoots', 'workspace_roots']) {
    if (!Array.isArray(meta[key])) continue
    for (const root of meta[key]) {
      const value = String(root || '').trim()
      if (value) roots.push(value)
    }
  }
  for (const key of ['workspaceRoot', 'workspace_root']) {
    const value = String(meta[key] || '').trim()
    if (value) roots.push(value)
  }
  return Array.from(new Set(roots))
}

function machineDefaultPath(machine) {
  const meta = machine?.metadata || machine?.data || machine || {}
  const roots = machineWorkspaceRoots(machine)
  if (roots[0]) return roots[0]
  const candidates = [
    meta.workspaceRoot,
    meta.workspace_root,
    meta.workspace,
    meta.cwd,
    meta.currentDirectory,
    meta.homeDir,
    meta.home,
  ].filter(Boolean)
  if (candidates[0]) return String(candidates[0])
  const platform = String(meta.platform || meta.os || '').toLowerCase()
  return platform.includes('win') ? 'C:/' : '/'
}

function isDirectoryEntry(entry) {
  const type = String(entry?.type || entry?.kind || '').toLowerCase()
  return type === 'directory' || type === 'dir' || entry?.isDirectory === true || entry?.directory === true
}

function directoryEntryName(entry) {
  return String(entry?.name || entry?.basename || entry?.path || entry?.fullPath || '')
}

function directoryEntryPath(entry, current) {
  const direct = String(entry?.fullPath || entry?.path || '')
  if (direct) return direct
  return joinRemotePath(current, directoryEntryName(entry))
}

function joinRemotePath(base, name) {
  const root = String(base || '/')
  const child = String(name || '').replace(/^[/\\]+/, '')
  if (/^[a-z]:\/?$/i.test(root)) return `${root.replace(/\/?$/, '/')}${child}`
  if (root === '/') return `/${child}`
  return `${root.replace(/[/\\]+$/, '')}/${child}`
}

function parentPath(path) {
  const value = String(path || '/').replace(/[/\\]+$/, '')
  if (!value || value === '/' || /^[a-z]:$/i.test(value)) return value ? `${value}/` : '/'
  const idx = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  if (idx <= 0) return value.includes(':') ? `${value.slice(0, 2)}/` : '/'
  return value.slice(0, idx)
}

function isPathWithinRoots(path, roots) {
  const target = normalizeRemotePath(path)
  return roots.some(root => {
    const base = normalizeRemotePath(root)
    const [left, right] = /^[a-z]:/i.test(base) || /^[a-z]:/i.test(target)
      ? [target.toLowerCase(), base.toLowerCase()]
      : [target, base]
    if (right === '/') return left.startsWith('/')
    return left === right || left.startsWith(`${right}/`)
  })
}

function normalizeRemotePath(path) {
  const value = String(path || '/').replace(/\\/g, '/').replace(/\/+$/, '')
  return value || '/'
}

function normalizeModelInput(input) {
  const value = String(input || '').trim()
  const match = value.match(/^(opus|sonnet|fable)(?:\[?1m\]?|-?1m)$/i)
  if (match) return `${match[1].toLowerCase()}[1m]`
  return value
}

function parseCreateOptions(agent, tokens = []) {
  const flavor = String(agent || '').toLowerCase()
  const modelModes = flavor === 'gemini' ? GEMINI_MODEL_MODES : flavor === 'claude' ? MODEL_MODES : []
  const efforts = flavor === 'opencode' ? OPENCODE_EFFORTS : flavor === 'codex' ? CODEX_EFFORTS : flavor === 'claude' ? CLAUDE_EFFORTS : []
  const permissionModes = PERMISSION_MODES[flavor] || []
  const acceptsFreeModel = ['codex', 'opencode'].includes(flavor)
  const options = {
    sessionType: 'simple',
    yolo: false,
    model: '',
    effort: '',
    permission: '',
  }

  for (const token of tokens.map(item => String(item || '').trim()).filter(Boolean)) {
    const lower = token.toLowerCase()
    if (['simple', 'worktree'].includes(lower)) {
      options.sessionType = lower
      continue
    }
    if (['yolo', 'true', '1', '是'].includes(lower)) {
      options.yolo = true
      continue
    }

    if (modelModes.length) {
      const model = resolveChoice(token, modelModes, { model: true })
      if (modelModes.includes(model)) {
        options.model = model
        continue
      }
    }

    const effort = ['inherit', 'auto', 'default'].includes(lower) ? '' : lower
    if (efforts.includes(effort) || (lower === 'default' && efforts.includes('default'))) {
      options.effort = effort
      continue
    }

    const permission = resolveChoice(token, permissionModes)
    if (permissionModes.includes(permission)) {
      options.permission = permission
      continue
    }

    if (acceptsFreeModel && !options.model) {
      options.model = token
    }
  }

  return options
}

function sourceKey(source) {
  if (!source) return ''
  if (source.kind === 'path') return `path:${source.path}`
  if (source.kind === 'url') return `url:${source.url}`
  return `inline:${source.data}`
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length)
  let nextIndex = 0
  const workerCount = Math.min(Math.max(Number(limit) || 1, 1), items.length)
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

async function sendByWindowKey(key, text) {
  try {
    const [, self, type, id] = key.split(':')
    const bot = global.Bot?.[self] || global.Bot
    const target = type === 'group' ? bot.pickGroup(id) : bot.pickUser(id)
    return smartReply({
      reply: msg => target.sendMsg(msg),
    }, text)
  } catch (err) {
    logger.warn(`[hapi-connector] 主动推送失败: ${err.message || err}`)
  }
}

async function buildEventFromWindowKey(key) {
  const [, self, type, id] = String(key).split(':')
  if (!self || !type || !id) return null
  const cached = State.eventCache.get(key) || {}
  const isGroup = type === 'group'
  const userId = String(cached.user_id || cached.sender?.user_id || (isGroup ? '' : id))
  const event = {
    self_id: self,
    user_id: userId,
    group_id: isGroup ? id : undefined,
    post_type: 'message',
    message_type: isGroup ? 'group' : 'private',
    sub_type: 'normal',
    isGroup,
    isPrivate: !isGroup,
    isMaster: cached.isMaster,
    sender: cached.sender || { user_id: userId, nickname: 'hapi-connector' },
    message: [],
    msg: '',
    raw_message: '',
  }
  try {
    if (global.Bot && typeof Bot.prepareEvent === 'function') {
      await Bot.prepareEvent(event)
    }
  } catch (err) {
    logger.warn(`[hapi-connector] 构造推送事件失败: ${err.message || err}`)
  }
  return event
}
