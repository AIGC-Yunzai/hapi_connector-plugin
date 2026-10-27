import { qqbotAdapter } from '../adapter/QQBotOfficial.js'
import { accountStore } from '../adapter/qqbot/store.js'
import { runBindFlow } from '../adapter/qqbot/onboard.js'
import { QQBOT_HELP } from '../utils/formatters.js'
import { accountStatusLabel } from '../utils/qqbotAccounts.js'

export { QQBOT_HELP }

const LOGIN_TIMEOUT_MS = 3 * 60 * 1000

/**
 * 官方机器人的 self_id 是 AppID、user_id 是 openid，都不在 masterQQ 里，
 * 所以 e.isMaster 对它恒为假——不设主人，它连 #hapi 指令都发不出去。
 * 这条提示必须跟在每次登录成功后面，否则用户会以为「加上了就能用」。
 */
const MASTER_HINT =
  '\n\n下一步：私聊该机器人发送 #设置主人，到运行云崽的控制台取验证码并输入。\n' +
  '设好主人之后，它才能执行 #hapi 指令和 > 快捷发送。'

function maskSecret(secret) {
  if (!secret) return '(未设置)'
  return secret.length <= 8 ? '****' : `${secret.slice(0, 4)}****${secret.slice(-4)}`
}

function formatTime(ts) {
  if (!ts) return '从未'
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(ts).toLocaleString('zh-CN')
}

/**
 * `#hapi qqbot …` 的全部子命令。
 * 调用方负责主人权限校验；这里只处理业务。
 *
 * @param {object} e 云崽事件
 * @param {string[]} args 子命令与参数，如 ['login', '102', 'secret']
 * @param {(msg: string, quote?: boolean) => Promise<any>} reply 回复函数
 */
export async function handleQQBotCommand(e, args, reply) {
  const [sub = '', ...rest] = args
  const cmd = String(sub).toLowerCase()

  switch (cmd) {
    case '':
    case 'help':
    case '帮助':
      return reply(QQBOT_HELP)
    case 'login':
    case '登录':
      return qqbotLogin(e, rest, reply)
    case 'list':
    case 'ls':
    case '列表':
      return qqbotList(reply)
    case 'status':
    case '状态':
      return qqbotStatus(rest[0], reply)
    case 'logout':
    case '退出':
      return qqbotLogout(rest[0], reply)
    case 'remove':
    case 'del':
    case '删除':
      return qqbotRemove(rest[0], reply)
    case 'markdown':
    case 'md':
      return qqbotMarkdown(rest[0], rest[1], reply)
    default:
      return reply(`未知的 qqbot 子命令：${cmd}\n\n${QQBOT_HELP}`)
  }
}

async function qqbotLogin(e, args, reply) {
  if (args.length >= 2) {
    const [appid, secret] = args
    if (!/^\d+$/.test(appid)) return reply('AppID 应该是纯数字，请检查后重试')
    try {
      accountStore.upsert({ appid, secret })
      await qqbotAdapter.login(appid)
      return reply(`机器人 ${appid} 已添加并开始连接。\n用 #hapi qqbot status ${appid} 查看状态。${MASTER_HINT}`)
    } catch (err) {
      return reply(`添加失败：${err.message}`)
    }
  }

  await reply('正在申请扫码绑定，二维码马上发来…\n 1. 如果未创建 QQ Bot ，在扫码后先创建 QQ Bot ，然后再扫一次码，即可绑定\n 2. 如果已经有 QQ Bot ，则扫码绑定即可')

  let result
  try {
    result = await runBindFlow(
      async base64 => {
        await e.reply(segment.image(`base64://${base64}`))
      },
      { timeoutMs: LOGIN_TIMEOUT_MS },
    )
  } catch (err) {
    return reply(
      `扫码流程启动失败：${err.message}\n\n` +
        '可以改用：\n#hapi qqbot login <AppID> <AppSecret>\n' +
        '（在 QQ 开放平台 q.qq.com 创建机器人后可复制这两个值）',
    )
  }

  if (result.status === 'expired') return reply('二维码已过期，请重新执行 #hapi qqbot login')
  if (result.status === 'timeout') return reply('等待扫码超时，请重新执行 #hapi qqbot login')
  if (result.status !== 'created') return reply(`扫码未完成：${result.message || result.status}`)

  try {
    accountStore.upsert({ appid: result.appid, secret: result.secret })
    await qqbotAdapter.login(result.appid)
    return reply(`扫码成功，机器人 ${result.appid} 已添加。\n用 #hapi qqbot status ${result.appid} 查看连接状态。${MASTER_HINT}`)
  } catch (err) {
    return reply(`凭证已拿到但连接失败：${err.message}`)
  }
}

function qqbotList(reply) {
  const accounts = accountStore.list()
  if (!accounts.length) return reply('还没有机器人。发送 #hapi qqbot login 扫码添加。')

  const lines = accounts.map(account => {
    const status = qqbotAdapter.status(account.appid)
    const md = account.markdown === false ? '纯文本' : 'markdown'
    return `${account.appid}  ${accountStatusLabel(account, status)}  ${md}  ${maskSecret(account.secret)}`
  })
  return reply(['QQ 官方机器人：', ...lines].join('\n'))
}

function qqbotStatus(appid, reply) {
  if (!appid) return reply('用法：#hapi qqbot status <AppID>')
  const account = accountStore.get(appid)
  if (!account) return reply(`没有 AppID 为 ${appid} 的机器人`)

  const status = qqbotAdapter.status(appid)
  const lines = [
    `AppID：${account.appid}`,
    `开关：${account.enabled ? '启用' : '停用'}`,
    `连接：${status.ready ? '在线' : status.online ? '连接中' : '离线'}`,
    `发送模式：${account.markdown === false ? '纯文本' : 'markdown'}`,
    `最近入站：${formatTime(status.lastInboundAt)}`,
    `群消息：${account.enable_group_c2c ? '已订阅' : '未订阅'}`,
    `频道私信：${account.enable_guild_direct_message ? '已订阅' : '未订阅'}`,
  ]
  if (status.lastError) lines.push(`最近错误：${status.lastError}`)
  return reply(lines.join('\n'))
}

async function qqbotLogout(appid, reply) {
  if (!appid) return reply('用法：#hapi qqbot logout <AppID>')
  const account = accountStore.get(appid)
  if (!account) return reply(`没有 AppID 为 ${appid} 的机器人`)

  const ok = await qqbotAdapter.logout(appid)
  qqbotAdapter.updateAccount(appid, { enabled: false })
  return reply(ok ? `机器人 ${appid} 已退出登录，凭证保留。` : `机器人 ${appid} 本来就不在线，已标记为停用。`)
}

async function qqbotRemove(appid, reply) {
  if (!appid) return reply('用法：#hapi qqbot remove <AppID>')
  const account = accountStore.get(appid)
  if (!account) return reply(`没有 AppID 为 ${appid} 的机器人`)

  await qqbotAdapter.remove(appid)
  return reply(`机器人 ${appid} 已删除，本地凭证已抹掉。\n若要彻底解除，还需到 q.qq.com 删除该机器人应用。`)
}

function qqbotMarkdown(appid, value, reply) {
  if (!appid || !value) return reply('用法：#hapi qqbot markdown <AppID> on|off')
  const account = accountStore.get(appid)
  if (!account) return reply(`没有 AppID 为 ${appid} 的机器人`)
  if (!/^(on|off|0|1|true|false|开|关|启用|停用)$/i.test(value)) return reply('取值只能是 on 或 off')

  const on = /^(on|1|true|开|启用)$/i.test(value)
  try {
    qqbotAdapter.updateAccount(appid, { markdown: on })
  } catch (err) {
    return reply(`保存失败：${err.message}`)
  }

  return reply(
    on
      ? `机器人 ${appid} 的普通文本将以 markdown 发送（平台拒绝时自动降级为纯文本）。`
      : `机器人 ${appid} 的普通文本将以纯文本发送。segment.markdown 仍按 markdown 发送。`,
  )
}
