import plugin from '../../../lib/plugins/plugin.js'
import Config from '../components/Config.js'
import { getHapiRuntime } from './HapiConnector.js'
import { isQuestionRequest } from '../utils/formatters.js'
import * as ops from '../components/SessionOps.js'

// 如使用非 icqq 且 e.self_id 无法正确识别，可在此处填写机器人 QQ 号。
const BotQQ = ''

export class hapiPokeApprove extends plugin {
  constructor() {
    super({
      name: 'hapi-connector-戳一戳审批',
      dsc: '戳一戳机器人批准 HAPI 普通权限请求',
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
    const { client, sse } = getHapiRuntime()
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
    if (!client || !items.length) {
      if (questionCount) await e.reply(`还有 ${questionCount} 个 question 请求，请用\n #hapi answer <序号> <答案> 回答`)
      return false
    }

    const lines = []
    for (const item of items) {
      const [ok, msg] = await ops.approvePermission(client, item.sid, item.rid)
      lines.push(`${ok ? 'OK' : 'FAIL'} #${item.req.index}: ${msg}`)
    }
    if (questionCount) lines.push(`还有 ${questionCount} 个 question 请求需回答：\n #hapi answer <序号> <答案>`)
    await e.reply(`[戳一戳审批]\n${lines.join('\n')}`)
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
