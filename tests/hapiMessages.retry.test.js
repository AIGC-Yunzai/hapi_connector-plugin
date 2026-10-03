import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyHapiMessage, scanRetryMessages } from '../utils/hapiMessages.js'

const errorText = 'Codex error: rate limit exceeded'

function agentMessage(seq, type, data) {
  return { seq, content: { role: 'agent', content: { type, data } } }
}

const errorMessages = [
  ['session message', agentMessage(7, 'event', { type: 'message', message: errorText })],
  ['session error', agentMessage(7, 'event', { type: 'error', message: errorText })],
  ['Codex error', agentMessage(7, 'codex', { type: 'error', message: errorText })],
  ['Codex task_failed', agentMessage(7, 'codex', { type: 'task_failed', error: errorText })],
]

for (const [name, message] of errorMessages) {
  test(`${name} matches configured retry text without counting as progress`, () => {
    assert.deepEqual(scanRetryMessages([message], [errorText]), {
      matched: errorText, errorSeq: 7, progressSeq: 0,
    })
  })
}

test('Claude synthetic errors still participate in retry matching', () => {
  const text = 'API Error: Request rejected (429)'
  const message = agentMessage(7, 'output', {
    type: 'assistant',
    message: { model: '<synthetic>', content: [{ type: 'text', text }] },
  })
  assert.deepEqual(scanRetryMessages([message], ['API Error: Request rejected']), {
    matched: 'API Error: Request rejected', errorSeq: 7, progressSeq: 0,
  })
})

test('normal replies mentioning the error remain progress and never trigger retry', () => {
  const messages = [
    agentMessage(7, 'codex', { type: 'message', message: errorText }),
    agentMessage(8, 'output', {
      type: 'assistant', message: { content: [{ type: 'text', text: errorText }] },
    }),
  ]
  assert.deepEqual(scanRetryMessages(messages, [errorText]), {
    matched: '', errorSeq: 0, progressSeq: 8,
  })
})

test('ready and token-count after a Codex error do not indicate recovery', () => {
  const messages = [
    agentMessage(6, 'codex', { type: 'reasoning', message: 'Working' }),
    agentMessage(7, 'codex', { type: 'error', message: errorText }),
    agentMessage(8, 'event', { type: 'ready' }),
    agentMessage(9, 'event', { type: 'token-count' }),
  ]
  assert.deepEqual(scanRetryMessages(messages, [errorText]), {
    matched: errorText, errorSeq: 7, progressSeq: 6,
  })
})

test('progress after a Codex error lets the listener suppress retry', () => {
  const messages = [
    agentMessage(7, 'codex', { type: 'error', message: errorText }),
    agentMessage(8, 'codex', { type: 'reasoning', message: 'Working again' }),
    agentMessage(9, 'codex', { type: 'message', message: 'Done' }),
  ]
  assert.deepEqual(scanRetryMessages(messages, [errorText]), {
    matched: errorText, errorSeq: 7, progressSeq: 9,
  })
})

test('errors require a configured case-sensitive substring', () => {
  const messages = [agentMessage(7, 'codex', { type: 'error', message: errorText })]
  for (const patterns of [[], ['API Error: Request rejected'], ['Rate limit exceeded']]) {
    assert.deepEqual(scanRetryMessages(messages, patterns), {
      matched: '', errorSeq: 0, progressSeq: 0,
    })
  }
  assert.deepEqual(scanRetryMessages(messages, ['rate limit exceeded']), {
    matched: 'rate limit exceeded', errorSeq: 7, progressSeq: 0,
  })
})

// HAPI 将 task_failed 转成 codex/message，失败来源保留在 data.id / localId。
function storedFailure(seq, suffix = 'task_failed') {
  const id = `codex:test-thread:test-turn:event-${seq}:${suffix}`
  return {
    ...agentMessage(seq, 'codex', {
      type: 'message', message: `${errorText}: Token rate limit exceeded.`, id,
    }),
    localId: id,
  }
}

for (const idField of ['both', 'payload', 'local']) {
  test(`stored Codex failure is an error with ${idField} ID`, () => {
    const message = storedFailure(155)
    if (idField === 'payload') delete message.localId
    if (idField === 'local') delete message.content.content.data.id
    const item = classifyHapiMessage(message)
    assert.equal(item.kind, 'error')
    assert.equal(item.text, message.content.content.data.message)
    assert.deepEqual(scanRetryMessages([message], [errorText]), {
      matched: errorText, errorSeq: 155, progressSeq: 0,
    })
  })
}

test('stored failure / ready / duplicate failure sequence still requires retry', () => {
  const messages = [
    agentMessage(152, 'codex', { type: 'reasoning', message: 'Working' }),
    storedFailure(155),
    agentMessage(156, 'event', { type: 'ready' }),
    storedFailure(157),
  ]
  assert.deepEqual(scanRetryMessages(messages, [errorText]), {
    matched: errorText, errorSeq: 157, progressSeq: 152,
  })
  messages.push(agentMessage(159, 'codex', { type: 'message', message: 'Recovered' }))
  assert.deepEqual(scanRetryMessages(messages, [errorText]), {
    matched: errorText, errorSeq: 157, progressSeq: 159,
  })
})

test('normal Codex messages quoting the error or failure ID remain normal replies', () => {
  for (const suffix of ['agent_message', 'task_failed:agent_message']) {
    const message = storedFailure(7, suffix)
    message.content.content.data.message += ' codex:thread:turn:hash:task_failed'
    assert.equal(classifyHapiMessage(message).kind, 'assistant-reply')
    assert.deepEqual(scanRetryMessages([message], [errorText]), {
      matched: '', errorSeq: 0, progressSeq: 7,
    })
  }
})
