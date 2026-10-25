/**
 * AGENT_NOTIFY_SUMMARY 页脚解析。
 *
 * 规则移植自 hapi 的 shared/src/messages.ts：页脚必须是**最后一个非空行**，
 * 允许粘在正文同一行（`Done.AGENT_NOTIFY_SUMMARY {…}`），允许缩进，
 * 但要拒绝叙述里的提及（`Example: AGENT_NOTIFY_SUMMARY …`）。
 * 不写成一条贪婪正则，是因为正文里也可能引用这段 token，贪婪匹配会吃掉半条消息。
 */

const NOTIFY_SUMMARY_PREFIX = 'AGENT_NOTIFY_SUMMARY '

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 在单行里找合法的页脚起始位置。
 *
 * 从左到右扫描 `AGENT_NOTIFY_SUMMARY `，第一个「剩余部分能解析成对象」的命中即页脚。
 * 向左看一个字符：前缀非空且紧邻空白时跳过——那是在正文里提到这个 token，
 * 不是页脚。粘行（`.`、`）`、中文标点等非空白字符）和缩进（前缀全空白）都放行。
 *
 * @param {string} line 单行文本
 * @returns {{ jsonPart: string, start: number } | null}
 */
export function matchNotifySummaryLine(line) {
  const text = String(line ?? '')
  for (
    let idx = text.indexOf(NOTIFY_SUMMARY_PREFIX);
    idx >= 0;
    idx = text.indexOf(NOTIFY_SUMMARY_PREFIX, idx + NOTIFY_SUMMARY_PREFIX.length)
  ) {
    const prefix = text.slice(0, idx)
    if (prefix.trim().length > 0 && /\s/.test(text[idx - 1] ?? '')) continue
    const jsonPart = text.slice(idx + NOTIFY_SUMMARY_PREFIX.length).trim()
    if (!jsonPart.startsWith('{') || !jsonPart.endsWith('}')) continue
    if (isObject(parseJson(jsonPart))) return { jsonPart, start: idx }
  }
  return null
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 只保留已知字段，避免把任意 JSON 透出去。
 * @param {string} jsonPart 形如 `{"status":"done"}` 的片段
 * @returns {object | null}
 */
export function parseNotifySummaryJson(jsonPart) {
  const parsed = parseJson(String(jsonPart ?? ''))
  if (!isObject(parsed)) return null
  const result = {}
  if (typeof parsed.version === 'number') result.version = parsed.version
  if (typeof parsed.agent === 'string') result.agent = parsed.agent
  if (typeof parsed.project === 'string') result.project = parsed.project
  if (typeof parsed.status === 'string') result.status = parsed.status
  if (typeof parsed.action === 'string') result.action = parsed.action
  if (typeof parsed.summary === 'string') result.summary = parsed.summary
  return result
}

function findNotifySummary(text) {
  const lines = text.split('\n')
  let lastIdx = lines.length - 1
  while (lastIdx >= 0 && lines[lastIdx].trim() === '') lastIdx -= 1
  if (lastIdx < 0) return null

  const line = lines[lastIdx].trimEnd()
  const match = matchNotifySummaryLine(line)
  if (match === null) return null

  const summary = parseNotifySummaryJson(match.jsonPart)
  if (summary === null) return null

  return { lines, lastIdx, line, match, summary }
}

/**
 * 读取消息末尾的摘要页脚。
 * @param {unknown} text
 * @returns {object | null} 解析出的摘要对象；格式不符返回 null
 */
export function extractNotifySummary(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  return findNotifySummary(text)?.summary ?? null
}

/**
 * 把尾部页脚从正文里切出来。原始消息不变，调用方按需只用 visibleText。
 * @param {unknown} text
 * @returns {{ visibleText: string, summary: object } | null}
 */
export function splitNotifySummary(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const found = findNotifySummary(text)
  if (found === null) return null

  const prefix = found.line.slice(0, found.match.start).trimEnd()
  const visibleLines = found.lines.slice(0, found.lastIdx)
  if (prefix.length > 0) visibleLines.push(prefix)

  return { visibleText: visibleLines.join('\n').trimEnd(), summary: found.summary }
}

/**
 * 去掉尾部页脚；畸形、出现在正文中间、不在最后一行的都不动。
 * @param {string} text
 * @returns {string}
 */
export function stripNotifySummaryFooter(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  return splitNotifySummary(text)?.visibleText ?? text
}

/**
 * 从一批已分类的消息里挑出「摘要消息」。
 *
 * 优先级：
 * 1. 最后一条带合法页脚的 assistant-reply；
 * 2. 否则最后一条 assistant-reply；
 * 3. 都没有则返回 null。
 *
 * @param {Array} items classifyHapiMessages 的产物
 * @returns {object | null} 摘要消息（正文已剥离页脚）
 */
export function selectSummaryItem(items) {
  const replies = (Array.isArray(items) ? items : [])
    .filter(item => item?.kind === 'assistant-reply')
  if (!replies.length) return null

  const withFooter = replies.filter(item => isObject(item.notifySummary))
  return withFooter.length ? withFooter[withFooter.length - 1] : replies[replies.length - 1]
}
