import assert from 'node:assert/strict'
import test from 'node:test'
import { SseListener } from '../components/SseListener.js'

const sid = 'channel-session'
const FOOTER = 'AGENT_NOTIFY_SUMMARY {"status":"done","summary":"改了 3 个文件"}'

function codexMessage(seq, text) {
  return { seq, content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: text } } } }
}

/**
 * 两条 assistant 回复，页脚挂在前一条上——用来验证「带页脚的那条」优先于
 * 「本批最后一条」被当成摘要。
 */
function batch() {
  return [
    codexMessage(1, `收尾结论，改了 3 个文件。\n\n${FOOTER}`),
    codexMessage(2, '顺手补了一条测试。'),
  ]
}

function setup(t) {
  const outputs = []
  const emitted = []
  const client = {
    async requestJson(method, path, options) {
      assert.equal(method, 'GET')
      assert.equal(path, `/api/sessions/${sid}/messages`)
      assert.equal(options.params.limit, 50)
      // 接口按新到旧返回，调用方按升序处理
      return { messages: batch().reverse() }
    },
  }
  const listener = new SseListener(client, [{ id: sid, metadata: { flavor: 'codex' } }], async payload => {
    outputs.push(payload)
  })
  listener.config = {
    output_level: 'simple',
    markdown_output: 'text',
    qqbot_markdown_output: 'text',
    retry_max_count: 0,
  }
  listener.sessionStates[sid] = { lastSeq: 0 }
  t.mock.method(listener, 'emitChannelOutput', async (plan, sessionId) => {
    assert.equal(sessionId, sid)
    emitted.push(plan)
  })
  const oldLogger = globalThis.logger
  globalThis.logger = { warn() {}, mark() {}, info() {}, error() {} }
  t.after(() => { globalThis.logger = oldLogger })
  return { listener, outputs, emitted }
}

const OFFICIAL = { isOfficial: true, outputLevel: 'simple', summaryMarkdown: true }
const ONEBOT = { isOfficial: false, outputLevel: 'simple', markdownOutput: 'text', summaryMarkdown: false }

test('official bot + text: one native markdown message, footer already stripped', async t => {
  const { listener, outputs, emitted } = setup(t)
  listener.profileFor = () => ({ ...OFFICIAL, markdownOutput: 'text' })

  await listener.notifyMessages(sid, 0)

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].kind, 'markdown')
  assert.match(emitted[0].content, /收尾结论/)
  assert.match(emitted[0].content, /顺手补了一条测试/)
  assert.doesNotMatch(emitted[0].content, /AGENT_NOTIFY_SUMMARY/)
  // 「会话已完成」照常发送
  assert.ok(outputs.some(item => String(item).includes('会话已完成')))
})

test('official bot + image: summary goes out as text, the rest becomes a picture', async t => {
  const { listener, emitted } = setup(t)
  listener.profileFor = () => ({ ...OFFICIAL, markdownOutput: 'image' })

  await listener.notifyMessages(sid, 0)

  assert.deepEqual(emitted.map(plan => plan.kind), ['markdown', 'image'])
  assert.match(emitted[0].content, /收尾结论/)
  assert.doesNotMatch(emitted[0].content, /顺手补了一条测试/)
  assert.match(emitted[1].markdown, /顺手补了一条测试/)
  assert.doesNotMatch(emitted[1].markdown, /收尾结论/)
})

test('official bot + silence pushes nothing at all', async t => {
  const { listener, outputs, emitted } = setup(t)
  listener.profileFor = () => ({ ...OFFICIAL, outputLevel: 'silence', markdownOutput: 'both' })

  await listener.notifyMessages(sid, 0)

  assert.deepEqual(emitted, [])
  assert.deepEqual(outputs, [])
})

test('other adapters keep the existing node-array payload', async t => {
  const { listener, outputs, emitted } = setup(t)
  listener.profileFor = () => ONEBOT

  await listener.notifyMessages(sid, 0)

  assert.deepEqual(emitted, [])
  const nodes = outputs.find(item => Array.isArray(item))
  assert.ok(Array.isArray(nodes), '非官方通道仍走节点数组（合并转发）')
  assert.equal(nodes.length, 3) // header + 2 条回复
})

test('a profile resolves per session; missing resolver falls back to config', async t => {
  const { listener, outputs, emitted } = setup(t)
  delete listener.profileFor
  await listener.notifyMessages(sid, 0)
  assert.deepEqual(emitted, [])
  assert.ok(outputs.some(item => Array.isArray(item)))
})
