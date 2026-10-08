import assert from 'node:assert/strict'
import test from 'node:test'
import { SseListener } from '../components/SseListener.js'

const sid = 'plan-session'
const plan = '# 实施计划\n\n1. Inspect\n2. Implement\n\n```js\nconst ready = true\n```'

function proposal(seq = 3) {
  return {
    seq,
    content: {
      role: 'agent',
      content: {
        type: 'codex',
        data: { type: 'tool-call', name: 'ExitPlanMode', callId: `plan-${seq}`, input: { plan } },
      },
    },
  }
}

function setup(config = {}) {
  const store = { messages: [] }
  const outputs = []
  const client = {
    async requestJson(method, path, options) {
      assert.equal(method, 'GET')
      assert.equal(path, `/api/sessions/${sid}/messages`)
      return { messages: store.messages.slice(-options.params.limit).reverse() }
    },
  }
  const listener = new SseListener(client, [{ id: sid, metadata: { flavor: 'codex' } }], async (payload, sessionId) => {
    assert.equal(sessionId, sid)
    outputs.push(payload)
  })
  listener.config = { output_level: 'simple', markdown_output: 'text', retry_max_count: 0, ...config }
  listener.sessionStates[sid] = { lastSeq: 0, thinking: true }
  const planOutputs = () => outputs.filter(payload => Array.isArray(payload) && payload[0]?.startsWith('plan #'))
  const received = message => listener.handle({ type: 'message-received', sessionId: sid, message })
  const updated = data => listener.handle({ type: 'session-updated', sessionId: sid, data })
  return { listener, store, outputs, planOutputs, received, updated }
}

for (const output_level of ['detail', 'simple', 'collapsed', 'summary']) {
  test(`${output_level}: a proposal is pushed immediately and only once across session updates`, async () => {
    const { store, listener, received, updated, planOutputs } = setup({ output_level })
    const message = proposal()
    store.messages = [message]
    await received(message)
    assert.deepEqual(planOutputs(), [[`plan #3\n${plan}`]])
    assert.equal(listener.sessionStates[sid].thinking, true)

    await updated({ thinking: true })
    await received(message)
    await updated({ thinking: false })
    assert.equal(planOutputs().length, 1)
    assert.equal(listener.sessionStates[sid].lastPlanSeq, 3)
  })
}

test('a new approval request fetches the proposal while the session is still thinking', async () => {
  const { store, listener, updated, planOutputs } = setup()
  store.messages = [proposal()]
  const requests = { approval: { tool: 'exit_plan_mode', toolCallId: 'plan-3', arguments: { plan } } }
  await updated({ thinking: true, agentState: { version: 1, value: { requests } } })
  assert.deepEqual(planOutputs(), [[`plan #3\n${plan}`]])
  assert.equal(listener.sessionStates[sid].thinking, true)
  await updated({ thinking: false, agentState: { requests: {} } })
  assert.equal(planOutputs().length, 1)
})

test('a proposal arriving after its approval request or after turn completion is still pushed', async () => {
  const { received, updated, planOutputs } = setup()
  await updated({ agentState: { requests: { approval: { tool: 'exit_plan_mode', arguments: { plan } } } } })
  assert.equal(planOutputs().length, 0)
  await received(proposal())
  assert.equal(planOutputs().length, 1)

  await updated({ thinking: false })
  await received(proposal(4))
  assert.deepEqual(planOutputs(), [[`plan #3\n${plan}`], [`plan #4\n${plan}`]])
})

test('turn completion fetches missed proposals even when summary would otherwise exclude them', async () => {
  const { store, updated, planOutputs } = setup({ output_level: 'summary', summary_msg_count: 1 })
  store.messages = [proposal(), {
    seq: 4,
    content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Ready' } } },
  }]
  await updated({ thinking: false })
  assert.deepEqual(planOutputs(), [[`plan #3\n${plan}`]])
})

test('the plan cursor only advances to a delivered plan, not unrelated later messages', async () => {
  const { store, listener, received, planOutputs } = setup()
  store.messages = [proposal(), {
    seq: 10,
    content: { role: 'agent', content: { type: 'event', data: { type: 'ready' } } },
  }]
  await listener.notifyPendingPlans(sid)
  assert.equal(listener.sessionStates[sid].lastPlanSeq, 3)
  await received(proposal(5))
  assert.equal(planOutputs().length, 2)
})

test('silence suppresses proposal output through all delivery paths', async () => {
  const { store, listener, received, updated, outputs } = setup({ output_level: 'silence' })
  store.messages = [proposal()]
  await received(proposal())
  await listener.notifyPendingPlans(sid)
  await updated({ thinking: false })
  assert.deepEqual(outputs, [])
})

test('a failed live push leaves the plan available for the turn-completion fallback', async t => {
  const { store, listener, received, updated, planOutputs } = setup()
  const oldLogger = globalThis.logger
  globalThis.logger = { warn() {} }
  t.after(() => { globalThis.logger = oldLogger })
  const notify = listener.notify
  const fail = t.mock.method(listener, 'notify', async () => { throw new Error('send failed') })
  store.messages = [proposal()]
  await received(proposal())
  assert.equal(listener.sessionStates[sid].lastPlanSeq, undefined)
  fail.mock.restore()
  assert.equal(listener.notify, notify)
  await updated({ thinking: false })
  assert.deepEqual(planOutputs(), [[`plan #3\n${plan}`]])
})
