import fs from 'node:fs'

if (!global.segment) {
  global.segment = (await import('oicq')).segment
}

logger.info(logger.yellow('[hapi-connector] 正在载入 hapi_connector-plugin'))

// QQ 官方机器人适配器：必须在 ListenerLoader 调 adapter.load() 之前注册，
// 所以放在插件模块顶层而不是 apps/ 里。
try {
  const { qqbotAdapter } = await import('./adapter/QQBotOfficial.js')
  if (Array.isArray(globalThis.Bot?.adapter) || typeof globalThis.Bot?.adapter?.push === 'function') {
    globalThis.Bot.adapter.push(qqbotAdapter)
  } else {
    logger.warn('[hapi-connector] 未找到 Bot.adapter，QQ 官方机器人适配器未注册')
  }
} catch (err) {
  logger.error('[hapi-connector] 载入 QQ 官方机器人适配器失败')
  logger.error(err)
}

const files = fs
  .readdirSync('./plugins/hapi_connector-plugin/apps')
  .filter(file => file.endsWith('.js'))

let ret = await Promise.allSettled(files.map(file => import(`./apps/${file}`)))
let apps = {}

for (let i in files) {
  const name = files[i].replace('.js', '')
  if (ret[i].status !== 'fulfilled') {
    logger.error(`[hapi-connector] 载入插件错误：${logger.red(name)}`)
    logger.error(ret[i].reason)
    continue
  }
  apps[name] = ret[i].value[Object.keys(ret[i].value)[0]]
}

logger.info(logger.green('[hapi-connector] hapi_connector-plugin 载入成功'))

export { apps }
