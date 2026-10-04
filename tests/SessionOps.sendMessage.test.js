import assert from 'node:assert/strict'
import test from 'node:test'
import { HapiClient } from '../components/HapiClient.js'
import { sendMessage } from '../components/SessionOps.js'

test('message IDs survive auth retries but differ for separate identical sends', async t => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'http://hapi.test/api/sessions/session/messages')
    assert.equal(options.method, 'POST')
    requests.push(JSON.parse(options.body))
    // 每次逻辑发送先遇到过期凭据，再由 HapiClient 重发。
    return new Response('{}', { status: requests.length % 2 ? 401 : 200 })
  })
  const client = new HapiClient({ hapi_endpoint: 'http://hapi.test' })
  t.mock.method(client, 'getToken', async () => 'test-token')

  assert.equal((await sendMessage(client, 'session', 'continue'))[0], true)
  assert.equal((await sendMessage(client, 'session', 'continue'))[0], true)

  assert.equal(requests.length, 4)
  assert.match(requests[0].localId, /^local-[0-9a-f-]{36}$/)
  assert.match(requests[2].localId, /^local-[0-9a-f-]{36}$/)
  assert.deepEqual(requests[0], requests[1])
  assert.deepEqual(requests[2], requests[3])
  assert.notEqual(requests[0].localId, requests[2].localId)
  assert.equal(requests[0].text, 'continue')
})
