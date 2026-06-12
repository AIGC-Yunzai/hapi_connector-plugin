import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

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

export function extractUploadSources(e) {
  const sources = []
  const seen = new Set()
  const items = [
    ...(Array.isArray(e?.message) ? e.message : []),
    ...(Array.isArray(e?.source?.message) ? e.source.message : []),
  ]

  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    if (!['image', 'file', 'video'].includes(item.type)) continue

    const name = item.name || item.filename || item.file_name || item.file || ''
    const mimeType = item.mimeType || item.mime_type || item.contentType || ''
    const candidates = [item.path, item.localPath, item.local_path, item.file]
    const localPath = candidates.map(normalizeLocalPath).find(Boolean)
    const url = normalizeUrl(item.url) || normalizeUrl(item.file)

    const source = localPath
      ? { kind: 'path', path: localPath, name: name && !/[\\/]/.test(name) ? name : path.basename(localPath), mimeType }
      : url
        ? { kind: 'url', url, name: name && !/[\\/]/.test(name) ? name : filenameFromUrl(url), mimeType }
        : null

    if (!source) continue
    const key = source.kind === 'path' ? source.path : source.url
    if (seen.has(key)) continue
    seen.add(key)
    sources.push(source)
  }
  return sources
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
