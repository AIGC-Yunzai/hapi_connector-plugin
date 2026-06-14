import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import fs from 'node:fs'
import path from 'node:path'

const _path = process.cwd()
const GIRL_IMAGE_DIR = path.join(_path, 'plugins', 'hapi_connector-plugin', 'resources', 'readme')
const GIRL_IMAGE_PATTERN = /^girl(?:\d+)?\.webp$/i

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
 * 根据输出方式返回应依次发送的内容数组
 * @param {string} mode 'text' 仅文字 / 'image' 仅图片 / 'both' 图片+文字（默认 text）
 * @param {*} textPayload 文字内容（字符串或节点数组）
 * @param {string} markdownContent 用于渲染图片的 markdown 文本
 * @returns {Promise<Array>} 待发送内容序列（文字在前、图片在后）
 */
export async function buildMarkdownOutputs(mode, textPayload, markdownContent) {
  const m = mode || 'text'
  const wantImage = m === 'image' || m === 'both'
  const wantText = m === 'text' || m === 'both'
  let img = null
  if (wantImage) img = await renderMarkdownImage(markdownContent)
  const outs = []
  // 仅图片模式渲染失败时回退为文字，避免什么都收不到
  if (wantText || !img) outs.push(textPayload)
  if (img) outs.push(img)
  return outs
}

export async function renderMarkdownImage(content) {
  if (!content || !String(content).trim()) return false
  try {
    const img = await puppeteer.screenshot('hapi-markdown', {
      _path,
      tplFile: './plugins/hapi_connector-plugin/resources/markdownPic/index.html',
      content: String(content),
      girlImage: pickGirlImage(),
    })
    return img || false
  } catch (err) {
    logger.warn(`[hapi-connector] 生成 markdown 图片失败: ${err?.message || err}`)
    return false
  }
}

function pickGirlImage() {
  try {
    const files = fs.readdirSync(GIRL_IMAGE_DIR)
      .filter(name => GIRL_IMAGE_PATTERN.test(name))
      .sort()
    const picked = files[Math.floor(Math.random() * files.length)] || 'girl.webp'
    return `${_path}/plugins/hapi_connector-plugin/resources/readme/${picked}`
  } catch {
    return `${_path}/plugins/hapi_connector-plugin/resources/readme/girl.webp`
  }
}
