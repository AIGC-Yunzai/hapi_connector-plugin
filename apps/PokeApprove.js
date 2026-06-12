import plugin from '../../../lib/plugins/plugin.js'
import { getHapiRuntime } from './HapiConnector.js'
import { isQuestionRequest } from '../utils/formatters.js'
import * as ops from '../components/SessionOps.js'

export class hapiPokeApprove extends plugin {
  constructor() {
    super({
      name: 'hapi-connector-戳一戳审批',
      dsc: '戳一戳机器人批准 HAPI 普通权限请求',
      event: 'notice',
      priority: 1008,
      rule: [
        {
          fnc: 'pokeApprove',
        },
      ],
    })
  }

  async pokeApprove(e) {
    if (!this.isPokeToSelf(e) || !e.isMaster) return false
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
      if (questionCount) await e.reply(`还有 ${questionCount} 个 question 请求，请用 #hapi answer <序号> <答案> 回答`)
      return false
    }

    const lines = []
    for (const item of items) {
      const [ok, msg] = await ops.approvePermission(client, item.sid, item.rid)
      lines.push(`${ok ? 'OK' : 'FAIL'} #${item.req.index}: ${msg}`)
    }
    if (questionCount) lines.push(`还有 ${questionCount} 个 question 请求需回答：#hapi answer <序号> <答案>`)
    await e.reply(`[戳一戳审批]\n${lines.join('\n')}`)
    return true
  }

  isPokeToSelf(e) {
    const type = String(e.sub_type || e.notice_type || '').toLowerCase()
    if (!type.includes('poke')) return false
    const selfId = String(e.self_id || e.bot?.uin || '')
    const targetId = String(e.target_id || e.user_id || '')
    return Boolean(selfId && targetId && selfId === targetId)
  }
}
