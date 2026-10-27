import test from 'node:test'
import assert from 'node:assert/strict'

import { convertVoiceToWav } from '../adapter/qqbot/voice.js'

test('没有 ffmpeg 时不下载也不转换，原样返回空串', async () => {
  let fetched = false
  const out = await convertVoiceToWav('https://x/a.silk', {
    bin: '__qqbot_missing_ffmpeg__',
    fetchImpl: async () => {
      fetched = true
      return { ok: true, arrayBuffer: async () => Buffer.from('x') }
    },
  })

  assert.equal(out, '')
  assert.equal(fetched, false, 'ffmpeg 不存在就不该浪费一次下载')
})

test('非 http(s) 地址直接跳过', async () => {
  assert.equal(await convertVoiceToWav('/tmp/a.silk'), '')
  assert.equal(await convertVoiceToWav(''), '')
})
