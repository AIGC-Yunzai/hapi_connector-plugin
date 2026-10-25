import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'

import {
  generateBindKey,
  decryptSecret,
  renderBindQr,
  buildConnectUrl,
  createBindTask,
  pollBindTask,
  BIND_STATUS,
} from '../adapter/qqbot/onboard.js'

/** 模拟服务端：用同一个 key 加密 secret，产出 IV‖ct‖tag 的 base64 */
function encryptLikeServer(secret, keyBase64) {
  const key = Buffer.from(keyBase64, 'base64')
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64')
}

test('绑定密钥是 32 字节 base64', () => {
  const key = generateBindKey()
  assert.equal(Buffer.from(key, 'base64').length, 32)
})

test('AES-256-GCM 解密与服务端加密互逆', () => {
  const key = generateBindKey()
  const secret = 'abcdefghijklmnopqrstuvwxyz012345'
  assert.equal(decryptSecret(encryptLikeServer(secret, key), key), secret)
})

test('密钥或密文长度异常时明确报错', () => {
  assert.throws(() => decryptSecret('AAAA', generateBindKey()), /密文长度异常/)
  assert.throws(() => decryptSecret(Buffer.alloc(40).toString('base64'), 'AAAA'), /密钥长度异常/)
})

test('二维码渲染成可直接发送的 base64 GIF', () => {
  const url = buildConnectUrl('task/with+special')
  assert.match(url, /^https:\/\/q\.qq\.com\/qqbot\/openclaw\/connect\.html\?task_id=task%2Fwith%2Bspecial&_wv=2$/)
  const base64 = renderBindQr(url)
  assert.ok(base64.length > 100)
  assert.match(Buffer.from(base64, 'base64').subarray(0, 6).toString('ascii'), /^GIF8[79]a$/)
})

test('createBindTask 解析 task_id，并按约定格式提交 key', async () => {
  let seen
  const fetchImpl = async (url, options) => {
    seen = { url, body: JSON.parse(options.body), headers: options.headers }
    return new Response(JSON.stringify({ retcode: 0, data: { task_id: 'T-1' } }), { status: 200 })
  }
  const task = await createBindTask({ fetchImpl })
  assert.equal(task.taskId, 'T-1')
  assert.equal(seen.url, 'https://q.qq.com/lite/create_bind_task')
  assert.equal(Buffer.from(seen.body.key, 'base64').length, 32)
  assert.equal(seen.headers.Accept, 'application/json')
})

test('createBindTask 在 retcode 非 0 时抛出服务端原文', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ retcode: 1001, msg: '风控拦截' }), { status: 200 })
  await assert.rejects(() => createBindTask({ fetchImpl }), /风控拦截/)
})

test('pollBindTask 覆盖 pending / created / expired 三种状态', async () => {
  const key = generateBindKey()

  const pending = async () => new Response(JSON.stringify({ retcode: 0, data: { status: BIND_STATUS.PENDING } }))
  assert.deepEqual(await pollBindTask('T', key, { fetchImpl: pending }), { status: 'pending' })

  const expired = async () => new Response(JSON.stringify({ retcode: 0, data: { status: BIND_STATUS.EXPIRED } }))
  assert.equal((await pollBindTask('T', key, { fetchImpl: expired })).status, 'expired')

  const secret = 's3cr3t-value'
  const created = async () =>
    new Response(
      JSON.stringify({
        retcode: 0,
        data: {
          status: BIND_STATUS.COMPLETED,
          bot_appid: '102030405',
          bot_encrypt_secret: encryptLikeServer(secret, key),
          user_openid: 'U-9',
        },
      }),
    )
  const result = await pollBindTask('T', key, { fetchImpl: created })
  assert.equal(result.status, 'created')
  assert.equal(result.appid, '102030405')
  assert.equal(result.secret, secret)
  assert.equal(result.userOpenid, 'U-9')
})

test('扫码成功但凭证不全时不返回半个账号', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ retcode: 0, data: { status: BIND_STATUS.COMPLETED, bot_appid: '102' } }))
  const result = await pollBindTask('T', generateBindKey(), { fetchImpl })
  assert.equal(result.status, 'error')
})
