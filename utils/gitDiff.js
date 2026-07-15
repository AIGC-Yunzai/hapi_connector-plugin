const ORDINARY_CHANGE_REGEX = /^1 (.)(.) (.{4}) (\d{6}) (\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) (.+)$/
const RENAME_COPY_REGEX = /^2 (.)(.) (.{4}) (\d{6}) (\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([RC])(\d{1,3}) (.+)\t(.+)$/
const UNMERGED_REGEX = /^u (.)(.) (.{4}) (\d{6}) (\d{6}) (\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([0-9a-f]+) (.+)$/
const NUMSTAT_REGEX = /^(\d+|-)\t(\d+|-)\t(.*)$/

const DIFF_COLUMNS = 84
const DIFF_ROWS_PER_PAGE = 210

/**
 * 从 git status --porcelain=v2 与 git diff --numstat 中提取工作区未暂存文件。
 */
export function parseUnstagedFiles(statusOutput, numstatOutput = '') {
  const stats = parseNumstat(numstatOutput)
  const files = []
  const seen = new Set()

  const add = (path, status, extra = {}) => {
    const cleanPath = String(path || '').replace(/\/$/, '')
    if (!cleanPath || seen.has(cleanPath)) return
    seen.add(cleanPath)
    files.push({
      path: cleanPath,
      status,
      ...(stats.get(cleanPath) || { added: 0, removed: 0, binary: false }),
      ...extra,
    })
  }

  for (const line of String(statusOutput || '').split('\n')) {
    if (line.startsWith('1 ')) {
      const match = ORDINARY_CHANGE_REGEX.exec(line)
      if (match && isWorktreeChanged(match[2])) add(match[9], statusName(match[2]))
      continue
    }
    if (line.startsWith('2 ')) {
      const match = RENAME_COPY_REGEX.exec(line)
      if (match && isWorktreeChanged(match[2])) {
        // porcelain v2 的顺序是当前路径、Tab、原路径。
        add(match[11], statusName(match[2]), { oldPath: match[12] })
      }
      continue
    }
    if (line.startsWith('u ')) {
      const match = UNMERGED_REGEX.exec(line)
      if (match) add(match[11], 'conflicted')
      continue
    }
    if (line.startsWith('? ')) add(line.slice(2), 'untracked')
  }

  return files
}

export function parseGitBranch(statusOutput) {
  const match = String(statusOutput || '').match(/^# branch\.head (.+)$/m)
  if (!match || ['(detached)', '(initial)'].includes(match[1])) return ''
  return match[1]
}

/**
 * 把单文件 unified diff 转成接近 Codex TUI 的行模型：行号、正负号、正文。
 */
export function parseUnifiedDiff(diffText) {
  const rows = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  let hunkCount = 0

  for (const raw of String(diffText || '').replace(/\r\n/g, '\n').split('\n')) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      if (hunkCount > 0) rows.push({ type: 'separator', content: '⋮' })
      hunkCount += 1
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      inHunk = true
      continue
    }

    if (!inHunk) {
      if (/^(?:diff --git|index |--- |\+\+\+ |new file mode |deleted file mode |similarity index |rename (?:from|to) )/.test(raw)) continue
      if (raw.trim()) rows.push({ type: 'meta', content: raw })
      continue
    }

    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      rows.push({ type: 'add', lineNumber: newLine, sign: '+', content: raw.slice(1) })
      newLine += 1
    } else if (raw.startsWith('-') && !raw.startsWith('---')) {
      rows.push({ type: 'del', lineNumber: oldLine, sign: '-', content: raw.slice(1) })
      oldLine += 1
    } else if (raw.startsWith(' ')) {
      rows.push({ type: 'context', lineNumber: newLine, sign: ' ', content: raw.slice(1) })
      oldLine += 1
      newLine += 1
    } else if (raw.startsWith('\\ No newline at end of file')) {
      rows.push({ type: 'meta', content: raw })
    } else if (raw) {
      rows.push({ type: 'meta', content: raw })
    }
  }

  return wrapRows(rows)
}

export function buildUntrackedDiff(content) {
  const normalized = String(content || '').replace(/\r\n/g, '\n')
  if (!normalized) return [{ type: 'meta', content: '空文件' }]
  const lines = normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n')
  return wrapRows(lines.map((line, index) => ({
    type: 'add',
    lineNumber: index + 1,
    sign: '+',
    content: line,
  })))
}

export function countDiffRows(rows) {
  let added = 0
  let removed = 0
  for (const row of rows || []) {
    if (row.type === 'add' && !row.continuation) added += 1
    if (row.type === 'del' && !row.continuation) removed += 1
  }
  return { added, removed }
}

/**
 * 生成当前 Markdown 图片模板可直接解析的 HTML/Markdown 页面。
 * 页面按显示行拆分，避免单张长图超过 Chromium 截图高度限制。
 */
export function buildDiffMarkdownPages(workspace, maxRows = DIFF_ROWS_PER_PAGE) {
  const files = Array.isArray(workspace?.files) ? workspace.files : []
  if (!files.length) return [renderPage(workspace, [], 1, 1)]

  const fragments = paginateFiles(files, maxRows)
  return fragments.map((page, index) => renderPage(workspace, page, index + 1, fragments.length))
}

export function isBinaryBuffer(buffer) {
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '')
  if (!raw.length) return false
  const sample = raw.subarray(0, Math.min(raw.length, 8192))
  if (sample.includes(0)) return true
  let controls = 0
  for (const byte of sample) {
    if (byte < 32 && ![9, 10, 13].includes(byte)) controls += 1
  }
  return controls / sample.length > 0.1
}

function parseNumstat(output) {
  const stats = new Map()
  for (const line of String(output || '').split('\n')) {
    const match = NUMSTAT_REGEX.exec(line)
    if (!match) continue
    const binary = match[1] === '-' || match[2] === '-'
    const value = {
      added: binary ? 0 : Number(match[1]),
      removed: binary ? 0 : Number(match[2]),
      binary,
    }
    const paths = normalizeNumstatPath(match[3])
    for (const path of paths) if (path) stats.set(path, value)
  }
  return stats
}

function normalizeNumstatPath(rawPath) {
  const path = String(rawPath || '').trim()
  if (path.includes('{') && path.includes('=>') && path.includes('}')) {
    const current = path.replace(/\{([^{}]+?)\s*=>\s*([^{}]+?)\}/g, (_, _oldPart, newPart) => newPart.trim())
    const old = path.replace(/\{([^{}]+?)\s*=>\s*([^{}]+?)\}/g, (_, oldPart) => oldPart.trim())
    return [path, current, old]
  }
  if (path.includes('=>')) {
    const parts = path.split(/\s*=>\s*/).map(item => item.trim()).filter(Boolean)
    return [path, parts.at(-1), parts[0]]
  }
  return [path]
}

function isWorktreeChanged(value) {
  return value !== ' ' && value !== '.'
}

function statusName(value) {
  return ({
    M: 'modified',
    A: 'added',
    D: 'deleted',
    R: 'renamed',
    C: 'renamed',
    U: 'conflicted',
  })[value] || 'modified'
}

function wrapRows(rows) {
  const result = []
  for (const row of rows) {
    if (!['add', 'del', 'context', 'meta'].includes(row.type)) {
      result.push(row)
      continue
    }
    const chunks = wrapText(row.content, DIFF_COLUMNS)
    chunks.forEach((content, index) => result.push({
      ...row,
      content,
      lineNumber: index === 0 ? row.lineNumber : '',
      sign: index === 0 ? row.sign : '',
      continuation: index > 0,
    }))
  }
  return result
}

function wrapText(value, columns) {
  const text = String(value ?? '').replace(/\t/g, '    ')
  if (!text) return ['']
  const chunks = []
  let chunk = ''
  let width = 0
  for (const char of text) {
    const size = charWidth(char)
    if (chunk && width + size > columns) {
      chunks.push(chunk)
      chunk = ''
      width = 0
    }
    chunk += char
    width += size
  }
  if (chunk || !chunks.length) chunks.push(chunk)
  return chunks
}

function charWidth(char) {
  const code = char.codePointAt(0) || 0
  return code >= 0x1100 && (
    code <= 0x115f || code === 0x2329 || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1faff)
  ) ? 2 : 1
}

function paginateFiles(files, maxRows) {
  const pages = []
  let page = []
  let used = 0
  const flush = () => {
    if (page.length) pages.push(page)
    page = []
    used = 0
  }

  for (const file of files) {
    const rows = file.rows?.length ? file.rows : [{ type: 'meta', content: file.binary ? '二进制文件发生变更' : '没有可显示的文本差异' }]
    let offset = 0
    while (offset < rows.length) {
      const headerRows = 3
      if (used && used + headerRows + 1 > maxRows) flush()
      const available = Math.max(maxRows - used - headerRows, 1)
      const end = Math.min(offset + available, rows.length)
      page.push({
        ...file,
        rows: rows.slice(offset, end),
        continuedBefore: offset > 0,
        continuedAfter: end < rows.length,
      })
      used += headerRows + end - offset
      offset = end
      if (offset < rows.length) flush()
    }
  }
  flush()
  return pages
}

function renderPage(workspace, fragments, page, totalPages) {
  const files = Array.isArray(workspace?.files) ? workspace.files : []
  const totals = files.reduce((sum, file) => ({
    added: sum.added + Number(file.added || 0),
    removed: sum.removed + Number(file.removed || 0),
  }), { added: 0, removed: 0 })
  const count = files.length
  const path = workspace?.path || '(未知工作区)'
  const branch = workspace?.branch ? ` · ${workspace.branch}` : ''
  const sid = workspace?.sid ? ` · ${String(workspace.sid).slice(0, 8)}` : ''
  const pageLabel = totalPages > 1 ? `<span class="codex-diff-page">${page}/${totalPages}</span>` : ''
  const notice = String(workspace?.notice || '')

  let body = ''
  if (notice) {
    body = `<div class="codex-diff-empty">${escapeHtml(notice)}</div>`
  } else if (!count) {
    body = '<div class="codex-diff-empty">工作区没有未暂存变更</div>'
  } else {
    body = fragments.map(renderFile).join('\n')
  }

  return [
    '<div class="codex-diff">',
    `  <div class="codex-diff-title">工作区未暂存变更 ${pageLabel}</div>`,
    `  <div class="codex-diff-workspace">${escapeHtml(path)}${escapeHtml(branch)}${escapeHtml(sid)}</div>`,
    notice ? '' : `  <div class="codex-diff-summary"><span class="codex-diff-bullet">•</span> <strong>Edited ${count} ${count === 1 ? 'file' : 'files'}</strong> <span class="codex-diff-stat-add">(+${totals.added}</span> <span class="codex-diff-stat-del">-${totals.removed})</span></div>`,
    body,
    '</div>',
  ].join('\n')
}

function renderFile(file) {
  const language = languageForPath(file.path)
  const continuation = file.continuedBefore || file.continuedAfter ? ' <span class="codex-diff-continuation">(续)</span>' : ''
  const rows = (file.rows || []).map(row => renderRow(row, language)).join('\n')
  return [
    '<section class="codex-diff-file">',
    `  <div class="codex-diff-file-head"><span class="codex-diff-tree">└</span> ${escapeHtml(file.path)}${continuation} <span class="codex-diff-file-stats"><span class="codex-diff-stat-add">+${Number(file.added || 0)}</span> <span class="codex-diff-stat-del">-${Number(file.removed || 0)}</span></span></div>`,
    `  <div class="codex-diff-lines">${rows}</div>`,
    '</section>',
  ].join('\n')
}

function renderRow(row, language) {
  const type = ['add', 'del', 'context', 'separator', 'meta'].includes(row.type) ? row.type : 'context'
  if (type === 'separator') {
    return '<div class="codex-diff-row separator"><span class="codex-diff-number"></span><span class="codex-diff-sign">⋮</span><span class="codex-diff-code"></span></div>'
  }
  const langAttr = language ? ` class="language-${escapeHtml(language)}" data-language="${escapeHtml(language)}"` : ''
  return [
    `<div class="codex-diff-row ${type}${row.continuation ? ' continuation' : ''}">`,
    `  <span class="codex-diff-number">${row.lineNumber ?? ''}</span>`,
    `  <span class="codex-diff-sign">${escapeHtml(row.sign || '')}</span>`,
    `  <span class="codex-diff-code"><code${langAttr}>${escapeHtml(row.content ?? '') || ' '}</code></span>`,
    '</div>',
  ].join('')
}

function languageForPath(filePath) {
  const name = String(filePath || '').split('/').pop() || ''
  if (/^dockerfile$/i.test(name)) return 'dockerfile'
  if (/^(?:makefile|gnumakefile)$/i.test(name)) return 'makefile'
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
  return ({
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
    c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp',
    cs: 'csharp', php: 'php', swift: 'swift', scala: 'scala', sh: 'bash', bash: 'bash', zsh: 'bash',
    json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
    html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', css: 'css', scss: 'scss', less: 'less',
    md: 'markdown', sql: 'sql', vue: 'xml', svelte: 'xml',
  })[ext] || ''
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
