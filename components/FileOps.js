import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const MEDIA_TYPES = new Set(['image', 'video', 'file', 'record', 'audio'])
const quotedContextCache = new WeakMap()

async function getFetch() {
  if (globalThis.fetch) return globalThis.fetch.bind(globalThis)
  const mod = await import('node-fetch')
  return mod.default
}

function guessMimeType(filename, fallback = 'application/octet-stream') {
  const ext = path.extname(filename).toLowerCase()
  const map = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.silk': 'audio/silk',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
    '.zip': 'application/zip',
  }
  return map[ext] || fallback
}

function filenameFromUrl(url) {
  try {
    const parsed = new URL(url)
    return decodeURIComponent(path.basename(parsed.pathname)) || 'upload'
  } catch {
    return 'upload'
  }
}

function normalizeLocalPath(raw) {
  if (!raw || typeof raw !== 'string') return ''
  let value = raw.trim()
  if (!value || /^(https?:|base64:|data:)/i.test(value)) return ''
  if (value.startsWith('file://')) value = fileURLToPath(value)
  return fs.existsSync(value) ? value : ''
}

function normalizeUrl(raw) {
  if (!raw || typeof raw !== 'string') return ''
  const value = raw.trim()
  return /^https?:\/\//i.test(value) ? value : ''
}

function normalizeInlineData(raw) {
  if (!raw || typeof raw !== 'string') return ''
  const value = raw.trim()
  return /^(base64:\/\/|data:[^;]+;base64,)/i.test(value) ? value : ''
}

async function getQuotedMessageContext(e) {
  if (!e || typeof e !== 'object') return emptyQuotedContext()
  const cached = quotedContextCache.get(e)
  if (cached) return cached
  const pending = resolveQuotedMessageContext(e)
  quotedContextCache.set(e, pending)
  return pending
}

async function resolveQuotedMessageContext(e) {
  try {
    if (e?.reply_id && typeof e.getReply === 'function') {
      const reply = await e.getReply(e.reply_id)
      const message = Array.isArray(reply) ? reply : Array.isArray(reply?.message) ? reply.message : []
      if (message.length || reply?.sender) {
        return {
          message,
          senderNickname: senderNameOf(reply?.sender),
          senderUserId: reply?.sender?.user_id,
          messageId: e.reply_id,
        }
      }
    }
  } catch (err) {
    logger.debug(`[hapi-connector] 获取 reply_id 引用消息失败: ${err.message || err}`)
  }

  try {
    if (!e?.source) return emptyQuotedContext()
    if (Array.isArray(e.source.message)) {
      const sender = await getSourceSender(e).catch(() => null)
      return {
        message: e.source.message,
        senderNickname: senderNameOf(sender),
        senderUserId: sender?.user_id || e.source.user_id,
        messageId: e.source.seq || e.source.time,
      }
    }
    const history = e.isGroup
      ? await e.group?.getChatHistory?.(e.source.seq, 1)
      : await e.friend?.getChatHistory?.(e.source.time, 1)
    const record = Array.isArray(history) ? history.pop() : null
    const message = Array.isArray(record?.message) ? record.message : []
    const sender = record?.sender || await getSourceSender(e).catch(() => null)
    return {
      message,
      senderNickname: senderNameOf(sender),
      senderUserId: sender?.user_id || e.source.user_id,
      messageId: e.source.seq || e.source.time,
    }
  } catch (err) {
    logger.debug(`[hapi-connector] 获取 source 引用消息失败: ${err.message || err}`)
    return emptyQuotedContext()
  }
}

function emptyQuotedContext() {
  return {
    message: [],
    senderNickname: '',
    senderUserId: '',
    messageId: '',
  }
}

async function getSourceSender(e) {
  if (!e?.source?.user_id) return null
  if (e.isGroup) {
    const member = await e.group?.pickMember?.(e.source.user_id)
    return member ? { card: member.card, nickname: member.nickname, user_id: e.source.user_id } : null
  }
  const friend = e.bot?.fl?.get?.(e.source.user_id)
  return friend ? { card: friend.card, nickname: friend.nickname, user_id: e.source.user_id } : null
}

function senderNameOf(sender) {
  return String(sender?.card || sender?.nickname || sender?.name || '').trim()
}

function textOfMessageItem(item) {
  if (typeof item === 'string') return item
  if (!item || typeof item !== 'object') return ''
  if (item.type !== 'text') return ''
  return String(item.text ?? item.data?.text ?? item.message ?? '').trim()
}

function buildQuotedText(context) {
  const text = context.message.map(textOfMessageItem).filter(Boolean).join('\n')
  if (!text) return ''
  const quotedLines = text.split('\n').map(line => `> ${line}`).join('\n')
  return context.senderNickname
    ? `> ##### ${context.senderNickname}：\n> ---\n${quotedLines}`
    : quotedLines
}

function applyQuotedText(e, context) {
  const quotedText = buildQuotedText(context)
  if (!quotedText) return ''
  e.sourceMsg = quotedText
  if (context.messageId) e.source_message_id = context.messageId
  if (context.senderNickname) {
    e.senderNickname = context.senderNickname
    e.senderUser_id = context.senderUserId
  }
  return quotedText
}

function pushItemSource(sources, seen, item) {
  if (!item || typeof item !== 'object') return
  if (!MEDIA_TYPES.has(item.type)) return

  const name = item.name || item.filename || item.file_name || item.fileName || item.file || ''
  const mimeType = item.mimeType || item.mime_type || item.contentType || item.content_type || ''
  const fileValue = item.file || item.url || item.path || item.localPath || ''
  const candidates = [item.path, item.localPath, item.local_path, item.file]
  const localPath = candidates.map(normalizeLocalPath).find(Boolean)
  const url = [item.url, item.file, item.href].map(normalizeUrl).find(Boolean)
  const inlineData = [item.file, item.url, item.data].map(normalizeInlineData).find(Boolean)

  const cleanName = name && !/[\\/]/.test(name) && !/^https?:\/\//i.test(name) ? name : ''
  const source = localPath
    ? { kind: 'path', path: localPath, name: cleanName || path.basename(localPath), mimeType }
    : url
      ? { kind: 'url', url, name: cleanName || filenameFromUrl(url), mimeType }
      : inlineData
        ? { kind: 'inline', data: inlineData, name: cleanName || defaultNameForItem(item, fileValue), mimeType }
        : null

  if (!source) return
  const key = source.kind === 'path' ? source.path : source.kind === 'url' ? source.url : source.data
  if (seen.has(key)) return
  seen.add(key)
  sources.push(source)
}

function defaultNameForItem(item, value = '') {
  const ext = path.extname(String(value)).toLowerCase()
  if (ext) return `upload${ext}`
  if (item.type === 'image') return 'image.png'
  if (item.type === 'video') return 'video.mp4'
  if (item.type === 'record' || item.type === 'audio') return 'audio.silk'
  return 'upload'
}

export async function extractUploadSources(e) {
  const sources = []
  const seen = new Set()
  const quoted = await getQuotedMessageContext(e)
  applyQuotedText(e, quoted)
  const items = [
    ...(Array.isArray(e?.message) ? e.message : []),
    ...(Array.isArray(e?.source?.message) ? e.source.message : []),
    ...(Array.isArray(e?.img) ? e.img.map(url => ({ type: 'image', url })) : []),
    ...quoted.message,
  ]

  for (const item of items) {
    pushItemSource(sources, seen, item)
  }
  return sources
}

export async function extractQuotedText(e) {
  if (typeof e?.sourceMsg === 'string' && e.sourceMsg.trim()) return e.sourceMsg.trim()
  const quoted = await getQuotedMessageContext(e)
  return applyQuotedText(e, quoted)
}

async function readSource(source) {
  if (source.kind === 'path') {
    const filename = source.name || path.basename(source.path)
    return {
      raw: fs.readFileSync(source.path),
      filename,
      mimeType: source.mimeType || guessMimeType(filename),
    }
  }

  if (source.kind === 'inline') {
    const filename = source.name || 'upload'
    const parsed = parseInlineData(source.data)
    return {
      raw: parsed.raw,
      filename,
      mimeType: source.mimeType || parsed.mimeType || guessMimeType(filename),
    }
  }

  const fetch = await getFetch()
  const res = await fetch(source.url)
  if (!res.ok) throw new Error(`下载附件失败: ${res.status} ${await res.text().catch(() => '')}`)
  const arrayBuffer = await res.arrayBuffer()
  const filename = source.name || filenameFromUrl(source.url)
  const headerMime = (res.headers.get('content-type') || '').split(';')[0].trim()
  return {
    raw: Buffer.from(arrayBuffer),
    filename,
    mimeType: source.mimeType || headerMime || guessMimeType(filename),
  }
}

function parseInlineData(data) {
  if (data.startsWith('base64://')) {
    return {
      raw: Buffer.from(data.replace(/^base64:\/\//i, ''), 'base64'),
      mimeType: '',
    }
  }
  const match = data.match(/^data:([^;]+);base64,(.+)$/i)
  if (!match) throw new Error('无法解析内联附件')
  return {
    raw: Buffer.from(match[2], 'base64'),
    mimeType: match[1],
  }
}

export async function uploadFile(client, sid, source) {
  try {
    const { raw, filename, mimeType } = await readSource(source)
    const payload = {
      filename,
      content: raw.toString('base64'),
      mimeType,
    }
    const res = await client.post(`/api/sessions/${sid}/upload`, { json: payload })
    const data = await res.json().catch(async () => ({ error: await res.text() }))
    if (!res.ok || !data.success || !data.path) {
      return [false, `上传失败 ${filename}: ${res.status} ${data.error || data.message || ''}`, null]
    }
    return [
      true,
      `已上传: ${filename}`,
      {
        id: crypto.randomUUID(),
        filename,
        mimeType,
        size: raw.length,
        path: data.path,
      },
    ]
  } catch (err) {
    return [false, `读取附件失败: ${err.message || err}`, null]
  }
}

export async function deleteUploadedFile(client, sid, remotePath) {
  const res = await client.post(`/api/sessions/${sid}/upload/delete`, { json: { path: remotePath } })
  const data = await res.json().catch(async () => ({ error: await res.text() }))
  if (res.ok && (data.success || data.ok)) return [true, `已删除: ${remotePath}`]
  return [false, `删除失败: ${res.status} ${data.error || data.message || ''}`]
}

export async function downloadToTmp(client, sid, remotePath) {
  const data = await client.requestJson('GET', `/api/sessions/${sid}/file`, { params: { path: remotePath } })
  if (!data.success || !data.content) throw new Error(data.error || data.message || '远端文件为空或不存在')
  const raw = Buffer.from(data.content, 'base64')
  const filename = path.basename(remotePath) || 'download'
  const tmpPath = path.join(os.tmpdir(), `hapi-${Date.now()}-${filename}`)
  fs.writeFileSync(tmpPath, raw)
  return {
    tmpPath,
    filename,
    isImage: IMAGE_EXTS.has(path.extname(filename).toLowerCase()),
    size: raw.length,
  }
}

export async function getRemoteFileSize(client, sid, remotePath) {
  try {
    const parent = path.posix.dirname(remotePath.replace(/\\/g, '/')) || '.'
    const filename = path.posix.basename(remotePath.replace(/\\/g, '/'))
    const data = await client.requestJson('GET', `/api/sessions/${sid}/directory`, { params: { path: parent } })
    const entry = (data.entries || []).find(item => item.name === filename)
    return entry?.size || 0
  } catch {
    return 0
  }
}
