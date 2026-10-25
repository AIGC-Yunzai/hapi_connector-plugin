/**
 * 通道策略：官方 QQ 机器人有一套只对它生效的推送参数。
 *
 * 判定依据是窗口背后的 bot 对象挂的适配器标识（`bot.adapter.id === 'QQBot'`），
 * 不是窗口键里的前缀——`State.windowKey()` 对任何适配器都写 `onebot:` 开头，
 * 前缀不可信。
 *
 * 一个会话同一时刻只归属一个窗口，所以策略在产出内容时就能定下来，
 * 不需要在发送时二次转换。
 */

/** 官方机器人适配器标识（与 adapter/QQBotOfficial.js 的 id 一致） */
export const QQBOT_ADAPTER_ID = 'QQBot'

const OUTPUT_LEVELS = new Set(['detail', 'simple', 'collapsed', 'summary', 'silence'])
const MARKDOWN_MODES = new Set(['text', 'image', 'both'])

/**
 * 拆窗口键 `<adapter>:<selfId>:<scene>:<target>`。
 * target 可能自带冒号（频道 `guild-channel`、含 `:` 的 openid），整体作为 target 返回。
 *
 * @param {string} key
 * @returns {{ selfId: string, scene: string, target: string } | null}
 */
export function parseWindowKey(key) {
  const parts = String(key || '').split(':')
  if (parts.length < 4) return null
  const scene = parts[2] === 'group' ? 'group' : 'private'
  return { selfId: parts[1], scene, target: parts.slice(3).join(':') }
}

function lookupBotByUin(uin) {
  return globalThis.Bot?.[uin]
}

function isOfficialAdapter(bot) {
  return Boolean(bot) && bot.adapter?.id === QQBOT_ADAPTER_ID
}

function pickOutputLevel(value) {
  const level = String(value || '').trim().toLowerCase()
  return OUTPUT_LEVELS.has(level) ? level : ''
}

function pickMarkdownMode(value) {
  const mode = String(value || '').trim().toLowerCase()
  return MARKDOWN_MODES.has(mode) ? mode : ''
}

/**
 * 全局策略（非官方机器人窗口、或窗口未知时使用）。
 * @param {object} config
 */
export function globalProfile(config = {}) {
  return {
    isOfficial: false,
    outputLevel: pickOutputLevel(config.output_level) || 'simple',
    markdownOutput: pickMarkdownMode(config.markdown_output) || 'text',
    summaryMarkdown: false,
  }
}

/**
 * 解析某个聊天窗口该用哪套推送参数。
 *
 * @param {string} windowKey State.windowKey() 的产物
 * @param {object} config 插件配置
 * @param {(uin: string) => object | undefined} [lookupBot] 注入点，测试用
 * @returns {{
 *   isOfficial: boolean,
 *   outputLevel: string,
 *   markdownOutput: 'text'|'image'|'both',
 *   summaryMarkdown: boolean,
 * }}
 */
export function resolveChannelProfile(windowKey, config = {}, lookupBot = lookupBotByUin) {
  const parsed = parseWindowKey(windowKey)
  const bot = parsed ? lookupBot(parsed.selfId) : null
  if (!isOfficialAdapter(bot)) return globalProfile(config)

  const global = globalProfile(config)
  const level = pickOutputLevel(config.qqbot_output_level)
  const mode = pickMarkdownMode(config.qqbot_markdown_output)

  return {
    isOfficial: true,
    // inherit（或写错的值）跟随全局
    outputLevel: level || global.outputLevel,
    markdownOutput: mode || 'text',
    summaryMarkdown: config.qqbot_summary_markdown !== false,
  }
}

/**
 * 通道策略是否要求「摘要单独走原生 markdown」。
 * 只有官方机器人且开关打开时才拆分消息。
 * @param {object} profile
 */
export function splitsSummary(profile) {
  return Boolean(profile?.isOfficial && profile.summaryMarkdown)
}
