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
      const title = text.slice(0, i)
      const body = text.slice(i + 1)
      const toolBody = toolBodyToMarkdown(title, body)
      if (toolBody !== null) return `**${title}**\n\n${toolBody}`
      const language = fenceLanguage(title, body)
      const content = language !== null ? fencedCode(body, language) : body
      return `**${title}**\n\n${content}`
    })
    .join('\n\n---\n\n')
}

function fenceLanguage(title, body) {
  const head = String(title || '').trim().toLowerCase()
  const text = String(body || '').trim()
  if (hasFencedCode(text)) return null
  const toolName = extractToolName(text)
  if (toolName && isShellToolName(toolName)) return 'bash'
  if (head.startsWith('system-event')) return ''
  if (head.startsWith('tool') || toolName) return ''
  return null
}

function toolBodyToMarkdown(title, body) {
  if (!isToolTitle(title)) return null
  const parsed = parseToolBody(body)
  if (!parsed) return String(body || '').trim()
  if (!parsed.detail || hasFencedCode(parsed.detail)) {
    return `${parsed.name}${parsed.detail ? `:\n${parsed.detail}` : ''}`.trim()
  }
  const language = toolCodeLanguage(parsed.name, parsed.detail)
  const content = language ? fencedCode(parsed.detail, language) : parsed.detail
  return `${parsed.name}:\n${content}`
}

function isToolTitle(title) {
  const head = String(title || '').trim().toLowerCase()
  return head === 'tool' || head.startsWith('tool ')
}

function parseToolBody(body) {
  const text = String(body || '').trim()
  if (!text) return null
  const legacy = text.match(/^工具\s+([^\s:]+)\s*:?\s*([\s\S]*)$/)
  if (legacy) return { name: legacy[1], detail: legacy[2].trim() }

  // Execute `cmd...`（Grok 原始 name，可能多行，命令在反引号内）
  const tick = text.match(/^([A-Za-z][\w.-]{0,40})\s*`([\s\S]*?)`\s*$/)
  if (tick) return { name: tick[1], detail: tick[2].trim() }

  // 工具名: 详情（工具名不含空白/冒号，避免把命令里的冒号当分隔）
  const current = text.match(/^([A-Za-z][\w.-]{0,40})\s*:\s*([\s\S]*)$/)
  if (current) return { name: current[1].trim(), detail: current[2].trim() }

  // Bash(cmd) / Execute(cmd)
  const paren = text.match(/^([A-Za-z][\w.-]{0,40})\s*\(([\s\S]*)\)\s*$/)
  if (paren) return { name: paren[1], detail: paren[2].trim() }

  return { name: text, detail: '' }
}

function isShellToolName(toolName) {
  const name = String(toolName || '').trim().toLowerCase()
  if (!name) return false
  if (/^(bash|shell|execute|exec|command|cmd|terminal|run_terminal_command|run_shell_command|codexbash)$/.test(name)) {
    return true
  }
  // 兼容 name 里仍带着 "Execute `...`" 的旧格式
  return /^(bash|shell|execute|exec|command|cmd|terminal)\b/.test(name)
    || /bash|shell|execute|run_terminal|run_shell|codexbash/i.test(name)
}

function toolCodeLanguage(toolName, detail) {
  const name = String(toolName || '')
  const text = String(detail || '').trim()
  if (isShellToolName(name)) return 'bash'
  if (/^(?:\/bin\/(?:ba)?sh\b|(?:ba)?sh\b|zsh\b|fish\b|git\b|node\b|npm\b|pnpm\b|yarn\b|python(?:3)?\b|npx\b|deno\b|bun\b|docker\b|kubectl\b|sed\b|awk\b|grep\b|rg\b|find\b|cat\b|ls\b|cd\b|mkdir\b|rm\b|cp\b|mv\b)/.test(text)) return 'bash'
  return ''
}

function hasFencedCode(text) {
  return /(^|\n)`{3,}/.test(String(text || ''))
}

function fencedCode(text, language = '') {
  const body = String(text || '').trim()
  const ticks = body.match(/`{3,}/g) || []
  const longest = ticks.reduce((max, item) => Math.max(max, item.length), 2)
  const fence = '`'.repeat(longest + 1)
  return `${fence}${language || ''}\n${body}\n${fence}`
}

function extractToolName(text) {
  const raw = String(text || '').trim()
  const tick = raw.match(/^(?:工具\s+)?([A-Za-z][\w.-]{0,40})\s*`/)
  if (tick) return tick[1]
  const match = raw.match(/^(?:工具\s+)?([A-Za-z][\w.-]{0,40})\s*:/)
  return match?.[1] || ''
}

/**
 * 根据输出方式返回应依次发送的内容数组
 * @param {string} mode 'text' 仅文字 / 'image' 仅图片 / 'both' 图片+文字（默认 text）
 * @param {*} textPayload 文字内容（字符串或节点数组）
 * @param {string} markdownContent 用于渲染图片的 markdown 文本
 * @param {string} theme 'auto' 自动 / 'light' 浅色 / 'dark' 深色（默认 light）
 * @returns {Promise<Array>} 待发送内容序列（文字在前、图片在后）
 */
export async function buildMarkdownOutputs(mode, textPayload, markdownContent, theme = 'light') {
  const m = mode || 'text'
  const wantImage = m === 'image' || m === 'both'
  const wantText = m === 'text' || m === 'both'
  let img = null
  if (wantImage) img = await renderMarkdownImage(markdownContent, theme)
  const outs = []
  // 仅图片模式渲染失败时回退为文字，避免什么都收不到
  if (wantText || !img) outs.push(textPayload)
  if (img) outs.push(img)
  return outs
}

export async function renderMarkdownImage(content, theme = 'light') {
  if (!content || !String(content).trim()) return false
  try {
    const themeClass = resolveMarkdownTheme(theme) === 'dark' ? 'theme-dark' : 'theme-light'
    const img = await puppeteer.screenshot('hapi-markdown', {
      _path,
      tplFile: './plugins/hapi_connector-plugin/resources/markdownPic/index.html',
      content: String(content),
      themeClass,
      girlImage: pickGirlImage(),
    })
    return img || false
  } catch (err) {
    logger.warn(`[hapi-connector] 生成 markdown 图片失败: ${err?.message || err}`)
    return false
  }
}

export function resolveMarkdownTheme(theme, now = new Date()) {
  const normalized = String(theme || '').trim().toLowerCase()
  if (normalized === 'dark') return 'dark'
  if (normalized !== 'auto') return 'light'
  const hour = now.getHours()
  return hour >= 6 && hour < 18 ? 'light' : 'dark'
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
