import test from 'node:test'
import assert from 'node:assert/strict'

import { QQBotApi, QQBotApiError } from '../adapter/qqbot/api.js'

/** 构造一个可编程的假 fetch：按顺序返回预设响应并记录请求 */
function sequencedFetch(responses) {
  const calls = []
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    const next = responses.shift()
    if (!next) throw new Error(`unexpected request: ${url}`)
    return next(url, options)
  }
  return { impl, calls }
}

const jsonResponse = body => new Response(JSON.stringify(body), { status: 200 })
const errorResponse = (status, body) => new Response(JSON.stringify(body), { status })

test('token 只换取一次并在有效期内复用，认证头是 QQBot 前缀', async () => {
  const { impl, calls } = sequencedFetch([
    () => jsonResponse({ access_token: 'tok-1', expires_in: 7200 }),
    () => jsonResponse({ url: 'wss://example/ws' }),
    () => jsonResponse({ id: 'msg-1' }),
  ])
  const api = new QQBotApi({ appid: '102', secret: 'sec', fetchImpl: impl })

  assert.equal(await api.getGatewayUrl(), 'wss://example/ws')
  await api.sendC2C('OPENID', { content: 'hi', msg_type: 0 })

  assert.equal(calls.length, 3)
  assert.equal(calls[0].url, 'https://bots.qq.com/app/getAppAccessToken')
  assert.deepEqual(JSON.parse(calls[0].options.body), { appId: '102', clientSecret: 'sec' })
  assert.equal(calls[1].options.headers.Authorization, 'QQBot tok-1')
  assert.equal(calls[2].url, 'https://api.sgroup.qq.com/v2/users/OPENID/messages')
})

test('401 会作废 token 并原样重发一次', async () => {
  const { impl, calls } = sequencedFetch([
    () => jsonResponse({ access_token: 'tok-1', expires_in: 7200 }),
    () => errorResponse(401, { code: 11244, message: 'token expired' }),
    () => jsonResponse({ access_token: 'tok-2', expires_in: 7200 }),
    () => jsonResponse({ id: 'ok' }),
  ])
  const api = new QQBotApi({ appid: '102', secret: 'sec', fetchImpl: impl })

  const body = { content: 'hi', msg_type: 0 }
  const result = await api.sendGroup('G1', body)

  assert.equal(result.id, 'ok')
  assert.equal(calls.length, 4)
  assert.equal(calls[1].options.headers.Authorization, 'QQBot tok-1')
  assert.equal(calls[3].options.headers.Authorization, 'QQBot tok-2')
  assert.equal(calls[1].options.body, calls[3].options.body, '重试必须原样重发请求体')
})

test('错误响应带出 HTTP 状态、业务 code 与路径，并区分永久/可重试', async () => {
  const { impl } = sequencedFetch([
    () => jsonResponse({ access_token: 'tok-1', expires_in: 7200 }),
    () => errorResponse(400, { code: 40034004, message: 'msg_id 无效' }),
  ])
  const api = new QQBotApi({ appid: '102', secret: 'sec', fetchImpl: impl })

  const err = await api.sendGroup('G1', {}).catch(e => e)
  assert.ok(err instanceof QQBotApiError)
  assert.equal(err.status, 400)
  assert.equal(err.code, 40034004)
  assert.match(err.path, /\/v2\/groups\/G1\/messages/)
  assert.match(err.message, /msg_id 无效/)
})

test('上传素材兼容 file_info 在顶层或被 data 包裹两种形态', async () => {
  const { impl, calls } = sequencedFetch([
    () => jsonResponse({ access_token: 'tok-1', expires_in: 7200 }),
    () => jsonResponse({ file_info: 'AAA' }),
    () => jsonResponse({ data: { file_info: 'BBB' }, file_uuid: 'uuid-2' }),
  ])
  const api = new QQBotApi({ appid: '102', secret: 'sec', fetchImpl: impl })

  const first = await api.uploadMedia({ scope: 'group', targetId: 'G1', fileType: 1, url: 'https://x/y.png' })
  assert.equal(first.fileInfo, 'AAA')
  assert.equal(calls[1].url, 'https://api.sgroup.qq.com/v2/groups/G1/files')
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    file_type: 1,
    srv_send_msg: false,
    url: 'https://x/y.png',
  })

  // 第二次走 users 路径 + base64，并带上文件名（file_type=4）；token 未过期因此不再请求
  const second = await api.uploadMedia({ scope: 'c2c', targetId: 'U1', fileType: 4, fileData: 'aGk=', fileName: 'a.txt' })
  assert.equal(second.fileInfo, 'BBB')
  assert.equal(calls.length, 3, 'token 应复用，不产生第三次认证请求')
  assert.equal(calls[2].url, 'https://api.sgroup.qq.com/v2/users/U1/files')
})

test('上传缺少 file_info 时抛错而不是静默返回空', async () => {
  const { impl } = sequencedFetch([
    () => jsonResponse({ access_token: 'tok-1', expires_in: 7200 }),
    () => jsonResponse({ ok: true }),
  ])
  const api = new QQBotApi({ appid: '102', secret: 'sec', fetchImpl: impl })
  await assert.rejects(() => api.uploadMedia({ scope: 'group', targetId: 'G1', fileType: 1, url: 'https://x' }), /file_info/)
})
