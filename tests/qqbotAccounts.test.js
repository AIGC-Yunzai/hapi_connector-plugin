import assert from 'node:assert/strict'
import test from 'node:test'
import { applyQQBotAccountDiff, buildQQBotAccountCards, diffQQBotAccounts } from '../utils/qqbotAccounts.js'

const CURRENT = [
  { appid: '1001', secret: 'secret-a', remark: '工作', enabled: true },
  { appid: '1002', secret: 'secret-b', remark: '', enabled: true },
  { appid: '1003', secret: 'secret-c', remark: '旧机器', enabled: false },
]

function fakeAdapter(overrides = {}) {
  const calls = []
  return {
    calls,
    remove: async appid => { calls.push(['remove', appid]) },
    updateAccount: (appid, patch) => { calls.push(['updateAccount', appid, patch]) },
    login: async appid => { calls.push(['login', appid]) },
    logout: async appid => { calls.push(['logout', appid]) },
    ...overrides,
  }
}

test('cards expose appid, remark, enabled and a status label only', () => {
  const status = { 1001: { ready: true, online: true }, 1002: { online: true } }
  const cards = buildQQBotAccountCards(CURRENT, appid => status[appid] || {})

  assert.deepEqual(cards, [
    { appid: '1001', remark: '工作', enabled: true, status: '在线' },
    { appid: '1002', remark: '', enabled: true, status: '连接中' },
    { appid: '1003', remark: '旧机器', enabled: false, status: '已停用' },
  ])
  for (const card of cards) assert.equal('secret' in card, false)
})

test('the diff deletes, updates and ignores exactly what changed', () => {
  const submitted = [
    { appid: '1001', remark: '工作', enabled: true, status: '在线' },
    { appid: '1002', remark: '生活', enabled: false, status: '在线' },
    { appid: '9999', remark: '手工加的', enabled: true },
  ]

  const diff = diffQQBotAccounts(CURRENT, submitted)

  assert.deepEqual(diff.remove, ['1003'])
  assert.deepEqual(diff.update, [{ appid: '1002', remark: '生活', enabled: false, reconnect: true }])
  assert.deepEqual(diff.ignored, ['9999'])
  // 没改过的不写
  assert.equal(diff.update.some(item => item.appid === '1001'), false)
  // 任何情况下都不带 secret
  for (const item of diff.update) assert.equal('secret' in item, false)
})

test('a remark-only change does not trigger a reconnect', () => {
  const diff = diffQQBotAccounts(CURRENT, [{ appid: '1002', remark: '改个名', enabled: true }])

  assert.deepEqual(diff.update, [{ appid: '1002', remark: '改个名', enabled: true, reconnect: false }])
})

test('missing enabled keeps the stored value instead of disabling everything', () => {
  const diff = diffQQBotAccounts(CURRENT, [{ appid: '1001', remark: '工作' }])

  assert.deepEqual(diff.update, [])
  assert.deepEqual(diff.remove, ['1002', '1003'])
})

test('an empty submission removes every account; a non-array submission is not a wipe', () => {
  assert.deepEqual(diffQQBotAccounts(CURRENT, []).remove, ['1001', '1002', '1003'])
  // 调用方负责在拿不到数组时不调用本函数，这里只保证 undefined 不会被当成空数组
  assert.deepEqual(diffQQBotAccounts(CURRENT, undefined).remove, ['1001', '1002', '1003'])
  assert.deepEqual(diffQQBotAccounts(CURRENT, null).update, [])
})

test('applying the diff deletes and disconnects the removed accounts', async () => {
  const adapter = fakeAdapter()
  const applied = await applyQQBotAccountDiff({ remove: ['1003'], update: [] }, adapter)

  assert.deepEqual(applied.removed, ['1003'])
  assert.deepEqual(adapter.calls, [['remove', '1003']])
})

test('disabling an account disconnects it; enabling reconnects it', async () => {
  const adapter = fakeAdapter()
  const applied = await applyQQBotAccountDiff({
    remove: [],
    update: [
      { appid: '1002', remark: '生活', enabled: false, reconnect: true },
      { appid: '1003', remark: '', enabled: true, reconnect: true },
    ],
  }, adapter)

  assert.deepEqual(applied.updated, ['1002', '1003'])
  assert.deepEqual(adapter.calls, [
    ['updateAccount', '1002', { remark: '生活', enabled: false }],
    ['logout', '1002'],
    ['updateAccount', '1003', { remark: '', enabled: true }],
    ['login', '1003'],
  ])
  // 只提交备注与启用状态，secret 永远不经过这里
  for (const call of adapter.calls) {
    if (call[0] !== 'updateAccount') continue
    assert.deepEqual(Object.keys(call[2]).sort(), ['enabled', 'remark'])
  }
})

test('a failed reconnect is reported without blocking the rest', async () => {
  const adapter = fakeAdapter({
    login: async appid => { throw new Error(`无法连接 ${appid}`) },
  })
  const applied = await applyQQBotAccountDiff({
    remove: ['1001'],
    update: [
      { appid: '1002', remark: '', enabled: true, reconnect: true },
      { appid: '1003', remark: '旧机器', enabled: false, reconnect: false },
    ],
  }, adapter)

  assert.deepEqual(applied.removed, ['1001'])
  assert.deepEqual(applied.updated, ['1003'])
  assert.deepEqual(applied.errors, [{ appid: '1002', message: '无法连接 1002' }])
})
