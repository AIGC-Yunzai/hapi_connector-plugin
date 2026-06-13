import plugin from '../../../lib/plugins/plugin.js'
import Config from '../components/Config.js'
import State from '../components/State.js'
import { HapiClient } from '../components/HapiClient.js'
import { SseListener } from '../components/SseListener.js'
import * as ops from '../components/SessionOps.js'
import {
  deleteUploadedFile,
  downloadToTmp,
  extractUploadSources,
  getRemoteFileSize,
  uploadFile,
} from '../components/FileOps.js'
import { smartReply } from '../utils/reply.js'
import {
  CLAUDE_EFFORTS,
  CODEX_EFFORTS,
  GEMINI_MODEL_MODES,
  MODEL_MODES,
  PERMISSION_MODES,
  formatDirectory,
  formatFiles,
  formatMessageNodes,
  formatPending,
  formatSessionList,
  formatSessionStatus,
  helpNodes,
  isQuestionRequest,
} from '../utils/formatters.js'

const sessionsCache = []
let sharedClient = null
let sharedSse = null
let booting = null

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
          reg: '^[>＞][\\s\\S]+$',
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

    if (!cmd || cmd === 'help' || cmd === '帮助') return this.reply(helpNodes(arg))

    try {
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
          return this.reply([`未知命令：#hapi ${cmd}`, ...helpNodes()])
      }
    } catch (err) {
      logger.error('[hapi-connector] 命令执行失败', err)
      return this.reply(`执行失败：${err.message || err}`)
    }
  }

  async quickSend(e) {
    if (!e.isMaster) return false
    if (!(await this.ready(e))) return true
    const prefix = this.config.quick_prefix || '>'
    const msg = String(e.msg || '')
    if (!msg.startsWith(prefix) && !(prefix === '>' && msg.startsWith('＞'))) return false

    const rest = msg.slice(msg.startsWith(prefix) ? prefix.length : 1).trim()
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
      const [, reply] = await ops.sendMessage(this.client, session.id, match[2], attachments)
      logger.info(`[hapi-connector] quickSend 触发: ${State.formatWindowKey(State.windowKey(e))} -> ${session.id.slice(0, 8)}`)
      if (uploadText) await this.reply(uploadText)
      return this.reply(reply)
    }

    const sid = State.currentSid(e)
    if (!sid) return this.reply('请先用 #hapi sw <序号> 选择一个 session')
    const [uploadText, attachments] = await this.uploadMessageAttachments(e, sid)
    const [, reply] = await ops.sendMessage(this.client, sid, rest, attachments)
    logger.info(`[hapi-connector] quickSend 触发: ${State.formatWindowKey(State.windowKey(e))} -> ${sid.slice(0, 8)}`)
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

    const text = request.text || `请查看这 ${attachments.length} 个附件。`
    const [, reply] = await ops.sendMessage(this.client, session.id, text, attachments)
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
      return this.reply(formatSessionList(sessionsCache, current))
    }
    const visible = State.visibleSessions(e, sessionsCache)
    return this.reply(formatSessionList(visible, current, sessionsCache))
  }

  async cmdSwitch(e, target) {
    await this.refreshSessions()
    const session = this.resolveSession(target)
    if (!session) return this.reply(`未找到匹配的 session：${target || '(空)'}`)
    State.setCurrent(e, session.id, session.metadata?.flavor || '')
    return this.reply(`已切换到 [${session.metadata?.flavor || '?'}] ${session.id.slice(0, 8)} ${session.metadata?.summary?.text || ''}`)
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
    const messages = await ops.fetchMessages(this.client, sid, limit)
    return this.reply(formatMessageNodes(messages))
  }

  async cmdTo(e, arg) {
    const parts = splitArgs(arg)
    if (parts.length < 2) return this.reply('用法：#hapi to <序号> <内容>')
    await this.refreshSessions()
    const session = this.resolveSession(parts[0])
    if (!session) return this.reply(`未找到 session：${parts[0]}`)
    const [uploadText, attachments] = await this.uploadMessageAttachments(e, session.id)
    const [, msg] = await ops.sendMessage(this.client, session.id, arg.slice(parts[0].length).trim(), attachments)
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
    if (isQuestionRequest(item.req)) return this.reply('这是 question 请求，请用 #hapi answer <序号> <答案>')
    const [, msg] = await ops.approvePermission(this.client, item.sid, item.rid)
    return this.reply(msg)
  }

  async cmdAnswer(e, arg) {
    const parts = splitArgs(arg)
    const item = this.findPending(parts[0])
    if (!item) return this.reply('未找到待回答请求')
    const answer = parts.slice(1).join(' ')
    if (!answer) return this.reply('用法：#hapi answer <序号> <答案或选项>')
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
    }

    const efforts = flavor === 'codex' ? CODEX_EFFORTS : flavor === 'claude' ? CLAUDE_EFFORTS : []
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

    return this.createSession(e, machineIdOf(machine), directory, agent, createOptions)
  }

  async createSession(e, machineId, directory, agent, createOptions) {
    const payload = {
      directory,
      agent,
      sessionType: createOptions.sessionType,
      yolo: createOptions.yolo,
    }
    if (createOptions.effort) payload.modelReasoningEffort = createOptions.effort
    const [ok, msg, sid] = await ops.spawnSession(this.client, machineId, payload)
    if (ok && sid) {
      State.setCurrent(e, sid, agent)
      await this.refreshSessions()
      await this.applyCreateOptions(sid, agent, createOptions)
    }
    return this.reply(msg)
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

  async applyCreateOptions(sid, agent, options) {
    const flavor = String(agent || '').toLowerCase()
    const lines = []
    if (options.model && ['claude', 'gemini'].includes(flavor)) {
      const [, msg] = await ops.setModelMode(this.client, sid, options.model)
      lines.push(msg)
    }
    if (options.permission) {
      const [, msg] = await ops.setPermissionMode(this.client, sid, options.permission)
      lines.push(msg)
    }
    if (options.effort && ['claude', 'codex'].includes(flavor)) {
      const [, msg] = await ops.setEffort(this.client, sid, options.effort, agent)
      lines.push(msg)
    }
    if (lines.length) await this.reply(lines.join('\n'))
  }

  async cmdSessionAction(e, arg, action) {
    await this.refreshSessions()
    const sid = this.resolveSession(arg)?.id || State.currentSid(e)
    if (!sid) return this.reply('请先选择 session，或提供序号/ID前缀')
    const [, msg] = await action(this.client, sid)
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
    const parts = splitArgs(arg)
    const confirm = parts.some(item => ['confirm', 'yes', '确认'].includes(item.toLowerCase()))
    const pathFilter = parts.filter(item => !['confirm', 'yes', '确认'].includes(item.toLowerCase())).join(' ')
    const targets = sessionsCache.filter(session => {
      if (session.active) return false
      if (!pathFilter) return true
      return String(session.metadata?.path || '').startsWith(pathFilter)
    })
    if (!targets.length) return this.reply('没有符合条件的 inactive session')
    if (!confirm) {
      return this.reply([
        `将清理 ${targets.length} 个 inactive session:`,
        formatSessionList(targets, '', sessionsCache),
        '',
        `确认执行请发送：#hapi clean${pathFilter ? ` ${pathFilter}` : ''} confirm`,
      ].join('\n'))
    }

    let okCount = 0
    const lines = []
    for (const session of targets) {
      const [ok, msg] = await ops.deleteSession(this.client, session.id)
      if (ok) {
        okCount += 1
        State.clearSession(session.id)
      }
      lines.push(msg)
    }
    await this.refreshSessions()
    return this.reply(`清理完成: ${okCount}/${targets.length}\n${lines.join('\n')}`)
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
    const modes = flavor === 'gemini' ? GEMINI_MODEL_MODES : MODEL_MODES
    if (!['claude', 'gemini'].includes(flavor)) return this.reply('模型切换仅支持 Claude / Gemini session')
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
    if (flavor === 'claude') {
      const next = detail.permissionMode === 'plan' ? 'default' : 'plan'
      const [, msg] = await ops.setPermissionMode(this.client, sid, next)
      return this.reply(msg)
    }
    return this.reply('Plan 模式仅支持 Claude / Codex session')
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
    const action = arg.trim().toLowerCase()
    if (!action) {
      State.bindPrimary(e)
      return this.reply('已设置当前聊天为默认通知窗口')
    }
    if (['claude', 'codex', 'gemini', 'opencode'].includes(action)) {
      State.bindPrimary(e, action)
      return this.reply(`已设置当前聊天为 ${action} 默认通知窗口`)
    }
    if (action === 'reset') {
      State.resetBindings(e)
      return this.reply('已清空当前窗口的 session 绑定和窗口状态')
    }
    if (action === 'status') return this.cmdRoutes(e)
    return this.reply('用法：#hapi bind [claude|codex|gemini|opencode|status|reset]')
  }

  async cmdRoutes() {
    await this.refreshSessions()
    const lines = ['HAPI 通知路由:']
    for (const session of sessionsCache) {
      const win = State.windowForSession(session)
      lines.push(`${session.id.slice(0, 8)} ${session.metadata?.flavor || '?'} -> ${State.formatWindowKey(win)}`)
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
    const lines = []
    const attachments = []
    for (const source of sources) {
      const [ok, msg, attachment] = await uploadFile(this.client, sid, source)
      lines.push(msg)
      if (ok && attachment) attachments.push(attachment)
    }
    return this.reply(`${lines.join('\n')}\n\n已上传 ${attachments.length}/${sources.length} 个附件到 [${sid.slice(0, 8)}]`)
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
        logger.debug(`[hapi-connector] 重建事件 reply 失败，尝试缓存事件: ${err.message || err}`)
      }
    }
    const cachedEvent = State.eventCache.get(key)
    if (cachedEvent?.reply) {
      try {
        await smartReply(cachedEvent, msg)
        return
      } catch (err) {
        logger.debug(`[hapi-connector] 缓存事件 reply 失败，尝试直接发送: ${err.message || err}`)
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
    const lines = []
    const attachments = []
    for (const source of sources) {
      const [ok, msg, attachment] = await uploadFile(this.client, sid, source)
      lines.push(msg)
      if (ok && attachment) attachments.push(attachment)
    }
    return [lines.join('\n'), attachments]
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

function splitLong(text, size = 3500) {
  if (typeof text !== 'string' || text.length <= size) return text
  const parts = []
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size))
  return parts
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

function isSkipText(text) {
  return ['跳过', '默认', 'default', 'skip', 'none', '无'].includes(String(text || '').trim().toLowerCase())
}

function resolveChoice(input, values, options = {}) {
  const raw = String(input || '').trim()
  if (/^\d+$/.test(raw)) return values[Number(raw) - 1]
  const normalized = options.model ? normalizeModelInput(raw) : raw
  return values.find(item => item.toLowerCase() === normalized.toLowerCase()) ?? normalized
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
  const efforts = flavor === 'codex' ? CODEX_EFFORTS : flavor === 'claude' ? CLAUDE_EFFORTS : []
  const permissionModes = PERMISSION_MODES[flavor] || []
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
    const model = resolveChoice(token, modelModes, { model: true })
    if (modelModes.includes(model)) {
      options.model = model
      continue
    }
    const effort = ['inherit', 'auto', 'default'].includes(lower) ? '' : lower
    if (efforts.includes(effort)) {
      options.effort = effort
      continue
    }
    const permission = resolveChoice(token, permissionModes)
    if (permissionModes.includes(permission)) {
      options.permission = permission
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

async function sendByWindowKey(key, text) {
  try {
    const [, self, type, id] = key.split(':')
    const bot = global.Bot?.[self] || global.Bot
    const target = type === 'group' ? bot.pickGroup(id) : bot.pickUser(id)
    return smartReply({
      reply: msg => target.sendMsg(msg),
    }, text)
  } catch (err) {
    logger.debug(`[hapi-connector] 主动推送失败: ${err.message || err}`)
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
    logger.debug(`[hapi-connector] 构造推送事件失败: ${err.message || err}`)
  }
  return event
}
