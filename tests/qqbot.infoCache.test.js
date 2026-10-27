import test from 'node:test'
import assert from 'node:assert/strict'

import { InfoCache } from '../adapter/qqbot/infoCache.js'

test('同一个 key 的成功结果会缓存，并发请求只打一次', async () => {
  let now = 0
  let calls = 0
  const cache = new InfoCache({ now: () => now })
  const loader = async () => {
    calls++
    await new Promise(resolve => setTimeout(resolve, 5))
    return { group_name: '测试群' }
  }

  const [first, second] = await Promise.all([cache.get('group:1', loader), cache.get('group:1', loader)])
  assert.equal(calls, 1, '并发只查一次')
  assert.equal(first.group_name, '测试群')
  assert.equal(second.group_name, '测试群')

  await cache.get('group:1', loader)
  assert.equal(calls, 1, '一小时内命中缓存')

  now += 60 * 60 * 1000 + 1
  await cache.get('group:1', loader)
  assert.equal(calls, 2, '过期后重新查')
})

test('查询失败返回 null 并缓存 5 分钟，不影响调用方', async () => {
  let now = 0
  let calls = 0
  const cache = new InfoCache({ now: () => now })
  const fail = async () => {
    calls++
    throw new Error('boom')
  }

  assert.equal(await cache.get('group:2', fail), null)
  assert.equal(await cache.get('group:2', fail), null)
  assert.equal(calls, 1, '失败也缓存，避免每条消息都等超时')

  now += 5 * 60 * 1000 + 1
  await cache.get('group:2', fail)
  assert.equal(calls, 2)
})

test('peek 只读缓存，不会触发请求', async () => {
  let calls = 0
  const cache = new InfoCache()
  const loader = async () => {
    calls++
    return { name: '频道' }
  }

  assert.equal(cache.peek('channel:1'), null)
  assert.equal(calls, 0)
  await cache.get('channel:1', loader)
  assert.equal(cache.peek('channel:1').name, '频道')
})
