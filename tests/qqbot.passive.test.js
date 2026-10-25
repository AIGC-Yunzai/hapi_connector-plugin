import test from 'node:test'
import assert from 'node:assert/strict'

import { PassiveReplyTracker } from '../adapter/qqbot/passive.js'

function makeTracker(startAt = 1_000_000) {
  let now = startAt
  const tracker = new PassiveReplyTracker({ now: () => now })
  return { tracker, advance: ms => (now += ms) }
}

test('群聊最多 5 次，私聊最多 4 次', () => {
  const { tracker } = makeTracker()

  tracker.remember({ groupId: 'G1' }, { messageId: 'm-group' })
  const groupSeqs = []
  for (let i = 0; i < 5; i++) groupSeqs.push(tracker.take({ groupId: 'G1' }).msgSeq)
  assert.deepEqual(groupSeqs, [1, 2, 3, 4, 5])
  assert.equal(tracker.take({ groupId: 'G1' }), null)

  tracker.remember({ openid: 'U1' }, { messageId: 'm-c2c' })
  const c2cSeqs = []
  for (let i = 0; i < 4; i++) c2cSeqs.push(tracker.take({ openid: 'U1' }).msgSeq)
  assert.deepEqual(c2cSeqs, [1, 2, 3, 4])
  assert.equal(tracker.take({ openid: 'U1' }), null, '私聊第 5 次要被拒绝')
})

test('msg_id 原样回传，且每条入站消息独立计数', () => {
  const { tracker } = makeTracker()
  tracker.remember({ groupId: 'G1' }, { messageId: 'm1' })
  assert.equal(tracker.take({ groupId: 'G1' }).messageId, 'm1')
  assert.equal(tracker.take({ groupId: 'G1' }).messageId, 'm1')

  tracker.remember({ groupId: 'G1' }, { messageId: 'm2' })
  const entry = tracker.take({ groupId: 'G1' })
  assert.equal(entry.messageId, 'm2', '新消息到达后应改用新 msg_id')
  assert.equal(entry.msgSeq, 1, '新 msg_id 的序号从 1 重新开始')
})

test('群聊 5 分钟过期，私聊 60 分钟过期', () => {
  const { tracker, advance } = makeTracker()
  tracker.remember({ groupId: 'G1' }, { messageId: 'm1' })
  advance(5 * 60 * 1000 + 1)
  assert.equal(tracker.take({ groupId: 'G1' }), null)

  tracker.remember({ openid: 'U1' }, { messageId: 'm2' })
  advance(59 * 60 * 1000)
  assert.ok(tracker.take({ openid: 'U1' }), '私聊 59 分钟时仍可被动回复')
  advance(2 * 60 * 1000)
  assert.equal(tracker.take({ openid: 'U1' }), null, '私聊超过 60 分钟应失效')
})

test('频道不参与被动回复预算', () => {
  const { tracker } = makeTracker()
  tracker.remember({ channelId: 'C1', scope: 'channel' }, { messageId: 'm1' })
  assert.equal(tracker.take({ channelId: 'C1', scope: 'channel' }), null)
})

test('remaining 反映剩余配额，prune 清掉过期会话', () => {
  const { tracker, advance } = makeTracker()
  tracker.remember({ groupId: 'G1' }, { messageId: 'm1' })
  tracker.take({ groupId: 'G1' })
  assert.equal(tracker.remaining({ groupId: 'G1' }), 4)

  advance(6 * 60 * 1000)
  tracker.prune()
  assert.equal(tracker.chats.size, 0)
})
