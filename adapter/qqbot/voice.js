import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 入站语音转 wav。
 *
 * QQ 下发的语音是 silk，ASR / 播放大多不认；AstrBot 也是先转 wav，失败再退回原 URL。
 * 这里做同样的事：机器上有 ffmpeg 才转，没有（或转失败）就原样保留，绝不让消息发不出去。
 *
 * 说明：ffmpeg 原生不一定能解 silk，能解就转，不能解保持原样——和 AstrBot 的兜底一致。
 * 可用 `QQBOT_FFMPEG` 指定二进制路径。
 */
const FFMPEG = process.env.QQBOT_FFMPEG || 'ffmpeg'
const DOWNLOAD_TIMEOUT_MS = 5_000
const CONVERT_TIMEOUT_MS = 5_000
const TEMP_TTL_MS = 10 * 60 * 1000

const ffmpegCache = new Map()

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('timeout'))
    }, timeoutMs)
    timer.unref?.()
    child.once('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    child.once('exit', code => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`exit ${code}`))
    })
  })
}

/** ffmpeg 是否存在，按二进制路径缓存 */
export function hasFfmpeg(bin = FFMPEG) {
  if (!ffmpegCache.has(bin)) {
    ffmpegCache.set(bin, run(bin, ['-version'], 3000).then(() => true, () => false))
  }
  return ffmpegCache.get(bin)
}

function tempPath(ext, dir) {
  const name = `qqbot-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
  return path.join(dir, name)
}

/**
 * 下载并转成 wav；成功返回本地路径，任何一步失败返回空串。
 * 临时 wav 保留 10 分钟供插件取用，之后删除。
 */
export async function convertVoiceToWav(url, {
  fetchImpl = globalThis.fetch,
  bin = FFMPEG,
  tmpDir = os.tmpdir(),
  timeoutMs = CONVERT_TIMEOUT_MS,
} = {}) {
  if (!url || !/^https?:\/\//i.test(url)) return ''
  if (!(await hasFfmpeg(bin))) return ''

  const input = tempPath('.silk', tmpDir)
  const output = input.replace(/\.silk$/, '.wav')
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (!res.ok) return ''
    fs.writeFileSync(input, Buffer.from(await res.arrayBuffer()))
    await run(bin, ['-y', '-i', input, '-ar', '16000', '-ac', '1', output], timeoutMs)
    if (!fs.existsSync(output) || fs.statSync(output).size === 0) return ''
    setTimeout(() => fs.rmSync(output, { force: true }), TEMP_TTL_MS).unref?.()
    return output
  } catch {
    return ''
  } finally {
    fs.rmSync(input, { force: true })
  }
}
