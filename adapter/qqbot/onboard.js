import { createDecipheriv, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BIND_CONNECT_PATH, BIND_CREATE_PATH, BIND_POLL_PATH, PORTAL_HOST, buildUserAgent } from './constants.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
// 该库是 UMD 产物，插件 package.json 是 "type": "module"，
// 因此必须以 .cjs 后缀存放，否则会被当成 ESM 解析成一个空模块。
const qrcodeLib = require(path.resolve(here, '../../resources/qqbot/qrcode.cjs'))

const BIND_TIMEOUT_MS = 10_000
const POLL_INTERVAL_MS = 2_000

export const BIND_STATUS = { NONE: 0, PENDING: 1, COMPLETED: 2, EXPIRED: 3 }

/** 本地生成 32 字节 AES-256 密钥；服务端用它加密回传 AppSecret，全程不明文传输 */
export function generateBindKey() {
  return randomBytes(32).toString('base64')
}

export function buildConnectUrl(taskId, host = PORTAL_HOST) {
  const clean = String(host || PORTAL_HOST).replace(/^https?:\/\//, '').replace(/\/+$/, '')
  return `https://${clean}${BIND_CONNECT_PATH}?task_id=${encodeURIComponent(taskId)}&_wv=2`
}

/** 把绑定地址渲染成可直接发到聊天的 base64 GIF */
export function renderBindQr(url, { cellSize = 8, margin = 16 } = {}) {
  const qr = qrcodeLib(0, 'M')
  qr.addData(url)
  qr.make()
  const dataUrl = qr.createDataURL(cellSize, margin)
  return String(dataUrl).replace(/^data:image\/\w+;base64,/, '').replace(/^data:image\/\w+,/, '')
}

/**
 * 解密 bot_encrypt_secret。
 * 载荷是 base64(IV(12) ‖ ciphertext ‖ tag(16))，密钥就是创建任务时发出去的那把。
 */
export function decryptSecret(encryptedBase64, keyBase64) {
  const key = Buffer.from(keyBase64, 'base64')
  const raw = Buffer.from(encryptedBase64, 'base64')
  if (key.length !== 32) throw new Error('绑定密钥长度异常')
  if (raw.length <= 28) throw new Error('凭证密文长度异常')
  const nonce = raw.subarray(0, 12)
  const tag = raw.subarray(raw.length - 16)
  const ciphertext = raw.subarray(12, raw.length - 16)

  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

let cachedCookie = ''

/** 门户站有 JS 挑战页，先取一次 cookie 再调接口，避免纯 fetch 被 403 */
async function portalFetch(pathname, body, { fetchImpl = globalThis.fetch } = {}) {
  const url = `https://${PORTAL_HOST}${pathname}`
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': buildUserAgent(),
    Referer: `https://${PORTAL_HOST}/`,
  }
  if (cachedCookie) headers.Cookie = cachedCookie

  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(BIND_TIMEOUT_MS),
  })

  const setCookie = res.headers?.get?.('set-cookie')
  if (setCookie) cachedCookie = setCookie.split(';')[0]

  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`绑定接口返回非 JSON（HTTP ${res.status}），可能被风控拦截`)
  }
  if (!res.ok) throw new Error(`绑定接口失败 [${res.status}]：${data?.msg || data?.message || text.slice(0, 120)}`)
  if (data?.retcode !== undefined && Number(data.retcode) !== 0) {
    throw new Error(data?.msg || data?.message || '绑定接口返回失败')
  }
  return data
}

/** 第一步：创建绑定任务，返回 taskId 与本地密钥（密钥不要外传） */
export async function createBindTask(options = {}) {
  const key = generateBindKey()
  const data = await portalFetch(BIND_CREATE_PATH, { key }, options)
  const taskId = String(data?.data?.task_id || '')
  if (!taskId) throw new Error('创建绑定任务失败：响应缺少 task_id')
  return { taskId, key, url: buildConnectUrl(taskId) }
}

/** 第二步：轮询一次绑定结果 */
export async function pollBindTask(taskId, key, options = {}) {
  const data = await portalFetch(BIND_POLL_PATH, { task_id: taskId }, options)
  const payload = data?.data && typeof data.data === 'object' ? data.data : {}
  const status = Number(payload.status ?? BIND_STATUS.NONE)

  if (status === BIND_STATUS.PENDING || status === BIND_STATUS.NONE) return { status: 'pending' }

  if (status === BIND_STATUS.EXPIRED) return { status: 'expired', message: '二维码已过期' }

  if (status === BIND_STATUS.COMPLETED) {
    const appid = String(payload.bot_appid || '').trim()
    const encrypted = String(payload.bot_encrypt_secret || '').trim()
    if (!appid || !encrypted) return { status: 'error', message: '扫码成功但未返回完整凭证' }
    try {
      return { status: 'created', appid, secret: decryptSecret(encrypted, key), userOpenid: payload.user_openid || '' }
    } catch (err) {
      return { status: 'error', message: `凭证解密失败：${err.message}` }
    }
  }

  return { status: 'pending' }
}

/**
 * 在聊天里跑完整个扫码流程。
 *
 * @param {(image: string) => Promise<any>} sendImage 收到二维码图片时的回调
 * @param {object} opts
 * @param {number} [opts.timeoutMs] 总超时
 * @param {() => boolean} [opts.cancelled] 返回 true 时提前结束
 */
export async function runBindFlow(sendImage, { timeoutMs = 5 * 60 * 1000, cancelled = () => false, fetchImpl } = {}) {
  const task = await createBindTask({ fetchImpl })
  await sendImage(renderBindQr(task.url))

  const deadline = Date.now() + timeoutMs
  let pollFailed = false
  while (Date.now() < deadline) {
    if (cancelled()) return { status: 'cancelled' }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    let result
    try {
      result = await pollBindTask(task.taskId, task.key, { fetchImpl })
      pollFailed = false
    } catch (err) {
      // 轮询偶发失败不该打断整个流程，但要让用户看见至少一次
      if (!pollFailed) {
        pollFailed = true
        globalThis.logger?.warn?.(`[qqbot] 轮询绑定结果失败，继续重试：${err.message}`)
      }
      continue
    }
    if (result.status === 'created' || result.status === 'expired' || result.status === 'error') return result
  }
  return { status: 'timeout' }
}
