import puppeteer from '../../../lib/puppeteer/puppeteer.js'

const _path = process.cwd()

/**
 * 把节点数组（形如 `role #seq\n正文`）转换为带分隔线的 markdown 文本
 * @param {string[]} nodes 节点字符串数组
 * @returns {string}
 */
export function nodesToMarkdown(nodes) {
  return (Array.isArray(nodes) ? nodes : [nodes])
    .filter(item => item != null && String(item).trim())
    .map(item => {
      const text = String(item)
      const i = text.indexOf('\n')
      if (i < 0) return `**${text}**`
      return `**${text.slice(0, i)}**\n\n${text.slice(i + 1)}`
    })
    .join('\n\n---\n\n')
}

/**
 * 将 markdown 文本渲染为图片（segment.image），失败返回 false
 * @param {string} content markdown 文本
 * @returns {Promise<object|false>}
 */
export async function renderMarkdownImage(content) {
  if (!content || !String(content).trim()) return false
  try {
    const img = await puppeteer.screenshot('hapi-markdown', {
      _path,
      tplFile: './plugins/hapi_connector-plugin/resources/markdownPic/index.html',
      content: String(content),
    })
    return img || false
  } catch (err) {
    logger.warn(`[hapi-connector] 生成 markdown 图片失败: ${err?.message || err}`)
    return false
  }
}
