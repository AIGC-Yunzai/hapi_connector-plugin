/**
 * 官方 QQ 机器人通道的产出编排。
 *
 * 官方 bot 支持原生 markdown，不适合发图片；而「摘要」那段（AI 编程收尾时给用户
 * 看的结论）恰恰是手机端最该直接读到纯文本的部分。所以摘要单独走一条 markdown，
 * 其余内容才按输出方式处理。
 *
 * 这里只决定「产出哪几块内容」，不碰渲染与发送，便于单测。
 */

import { buildMarkdownOutputs, nodesToMarkdown } from './markdownPic.js'
import { splitsSummary } from './channelProfile.js'

export const OUTPUT_MARKDOWN = 'markdown'
export const OUTPUT_IMAGE = 'image'

/**
 * markdown 块：直接发出 content。
 * image 块：markdown 交给渲染器，text 是渲染失败时的纯文本兜底（不含 `---`）。
 *
 * @typedef {{ kind: 'markdown', content: string }
 *   | { kind: 'image', markdown: string, text: string }} ChannelOutput
 */

/**
 * 原生 markdown 用的节点拼装：标题加粗、块间空行。
 * 不用 nodesToMarkdown 的 `---` 分隔符——那是给图片渲染器的，QQ 原生 markdown
 * 对分隔线的支持不可靠，块之间留空行更稳。
 *
 * @param {Array<string>} nodes
 * @returns {string}
 */
export function toNativeMarkdown(nodes) {
  return (Array.isArray(nodes) ? nodes : [nodes])
    .filter(item => item != null && String(item).trim())
    .map(node => {
      const text = String(node)
      const i = text.indexOf('\n')
      return i < 0 ? text : `**${text.slice(0, i)}**\n\n${text.slice(i + 1)}`
    })
    .join('\n\n')
}

/**
 * 计算一批已格式化节点的产出计划。
 *
 * @param {string[]} nodes 已按推送级别过滤、已格式化的消息节点（M）
 * @param {number} summaryIndex 摘要节点在 nodes 里的下标（S），-1 表示没有
 * @param {string} header 会话抬头
 * @param {{ isOfficial: boolean, markdownOutput: string, summaryMarkdown: boolean }} profile
 * @returns {ChannelOutput[]} markdown 块直接发文本，image 块渲染成图片
 */
export function planQQBotOutput(nodes, summaryIndex, header, profile) {
  const list = (Array.isArray(nodes) ? nodes : [])
    .map(item => String(item ?? '').trim())
    .filter(Boolean)
  if (!list.length) return []

  const head = String(header ?? '').trim()
  const asText = items => toNativeMarkdown(head ? [head, ...items] : items)
  const asImage = items => nodesToMarkdown(head ? [head, ...items] : items)
  const mode = ['text', 'image', 'both'].includes(profile?.markdownOutput)
    ? profile.markdownOutput
    : 'text'

  const idx = Number.isInteger(summaryIndex) && summaryIndex >= 0 && summaryIndex < list.length
    ? summaryIndex
    : -1

  // 不拆分：一条 markdown 装下全部
  if (!splitsSummary(profile) || idx < 0) {
    const text = asText(list)
    const image = { kind: OUTPUT_IMAGE, markdown: asImage(list), text }
    if (mode === 'text') return [{ kind: OUTPUT_MARKDOWN, content: text }]
    if (mode === 'image') return [image]
    return [{ kind: OUTPUT_MARKDOWN, content: text }, image]
  }

  const summary = list[idx]
  const rest = list.filter((_, i) => i !== idx)

  // text：摘要本来就在正文里，不拆
  if (mode === 'text') return [{ kind: OUTPUT_MARKDOWN, content: asText(list) }]

  const outs = []
  // image：摘要单独走 markdown，正文只进图片，避免图片里再重复一遍摘要
  // both ：文本含全部，图片只放正文
  outs.push({
    kind: OUTPUT_MARKDOWN,
    content: asText(mode === 'image' ? [summary] : list),
  })
  // 正文为空（整批只有摘要）就不发图
  if (rest.length) {
    outs.push({ kind: OUTPUT_IMAGE, markdown: asImage(rest), text: asText(rest) })
  }
  return outs
}

/**
 * 把一块产出计划变成可发送的载荷。
 * markdown → 一段文本；image → 图片，渲染失败退回文本（避免内容整块丢失）。
 *
 * @param {ChannelOutput} plan
 * @param {string} [theme]
 * @returns {Promise<Array>} 交给回复/推送方法的载荷
 */
export async function materializeChannelOutput(plan, theme = 'light') {
  if (!plan) return []
  if (plan.kind !== OUTPUT_IMAGE) return plan.content ? [plan.content] : []
  // 渲染失败时发 text 而不是 markdown：后者带 `---`，原生 markdown 不认
  return buildMarkdownOutputs('image', plan.text || plan.markdown, plan.markdown, theme)
}
