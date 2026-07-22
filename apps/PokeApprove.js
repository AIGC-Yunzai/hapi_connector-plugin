import plugin from '../../../lib/plugins/plugin.js'
import Config from '../components/Config.js'
import State from '../components/State.js'
import { getHapiRuntime } from './HapiConnector.js'
import {
  formatPending,
  formatSessionListNodes,
  formatSessionStatus,
  isQuestionRequest,
} from '../utils/formatters.js'
import { normalizePokeAction, nextOutputLevel } from '../utils/pokeActions.js'
import { smartReply } from '../utils/reply.js'
import * as ops from '../components/SessionOps.js'

// 如使用非 icqq 且 e.self_id 无法正确识别，可在此处填写机器人 QQ 号。
const BotQQ = ''

export class hapiPokeApprove extends plugin {
  constructor() {
    super({
      name: 'hapi-connector-戳一戳动作',
      dsc: '戳一戳机器人执行已配置的 HAPI 动作',
      event: 'notice.*.poke',
      priority: 1008,
      rule: [
        {
          reg: '.*',
          fnc: 'pokeApprove',
          log: false,
        },
      ],
    })
  }

  async pokeApprove(e) {
    if (!Config.getConfig().enable_poke_approve) return false
    const cfg = await this.getCfg()
    if (!this.isPokeToSelf(e, cfg) || !this.isMasterOperator(e, cfg)) return false
    const config = Config.getConfig()
    const { client, sse, sessions } = getHapiRuntime()
    if (!client) return false
    const action = normalizePokeAction(config.poke_action)
    if (action === 'none') {
      await e.reply('收到戳一戳')
      return true
    }
    if (action === 'pending') {
      await smartReply(e, formatPending(sse?.getAllPending?.() || {}, sessions))
      return true
    }
    if (action === 'list') {
      const fresh = await ops.fetchSessions(client)
      sessions.splice(0, sessions.length, ...fresh)
      const visible = State.visibleSessions(e, sessions).filter(session => session.active || session.thinking)
      await smartReply(e, formatSessionListNodes(visible, State.currentSid(e), sessions, {
        routeLabel: session => State.formatRouteForSession(session, e),
      }))
      return true
    }
    if (action === 'status') {
      const sid = State.currentSid(e)
      if (!sid) await e.reply('请先用 #hapi sw <序号> 选择 session')
      else await e.reply(formatSessionStatus(await ops.fetchSessionDetail(client, sid)))
      return true
    }
    if (action === 'stop') {
      const sid = State.currentSid(e)
      if (!sid) await e.reply('请先用 #hapi sw <序号> 选择 session')
      else await e.reply((await ops.abortSession(client, sid))[1])
      return true
    }
    if (action === 'output_cycle') {
      const next = nextOutputLevel(config.output_level)
      Config.updateConfig('output_level', next)
      if (sse) sse.config = Config.getConfig()
      await e.reply(`推送级别已切换为: ${next}`)
      return true
    }

    const pending = sse?.getAllPending?.() || {}
    const items = []
    let questionCount = 0
    for (const [sid, reqs] of Object.entries(pending)) {
      for (const [rid, req] of Object.entries(reqs)) {
        if (isQuestionRequest(req)) {
          questionCount += 1
          continue
        }
        items.push({ sid, rid, req })
      }
    }
    if (!items.length) {
      if (questionCount) await e.reply(`还有 ${questionCount} 个 question 请求，请用\n #hapi answer <序号> <答案> 回答`)
      else await e.reply('没有待批准的普通请求')
      return true
    }

    const lines = []
    for (const item of items) {
      const [ok, msg] = await ops.approvePermission(client, item.sid, item.rid)
      lines.push(`${ok ? 'OK' : 'FAIL'} #${item.req.index}: ${msg}`)
    }
    if (questionCount) lines.push(`还有 ${questionCount} 个 question 请求需回答：\n #hapi answer <序号> <答案>`)
    await e.reply(`[戳一戳批准]\n${lines.join('\n')}`)
    return true
  }

  isPokeToSelf(e, cfg) {
    const targetId = String(e.target_id || '')
    return this.botIds(e, cfg).includes(targetId)
  }

  isMasterOperator(e, cfg) {
    const operatorId = String(e.operator_id || e.user_id || '')
    return Boolean(operatorId && cfg.masterQQ?.map(String).includes(operatorId))
  }

  botIds(e, cfg) {
    return [
      e.self_id,
      e.bot?.uin,
      cfg.qq,
      BotQQ,
    ].filter(Boolean).map(String)
  }

  async getCfg() {
    const mod = await import('../../../lib/config/config.js')
    return mod.default
  }
}
