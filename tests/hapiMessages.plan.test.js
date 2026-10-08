import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyHapiMessage,
  classifyHapiMessages,
  formatHapiMessageNodes,
  formatPlanMarkdown,
} from '../utils/hapiMessages.js'
import { extractTextPreview } from '../utils/formatters.js'

const plan = '# 实施计划\n\n1. Inspect **input.plan**\n2. Render Markdown\n\n```js\nconst ready = true\n```\n\n'
  + '保留完整计划正文。'.repeat(250)

function proposal(name, input = { plan }) {
  return {
    seq: 3,
    content: {
      role: 'agent',
      content: { type: 'codex', data: { type: 'tool-call', name, callId: 'codex-proposed-plan:1', input } },
    },
  }
}

for (const name of ['ExitPlanMode', 'exit_plan_mode']) {
  test(`${name} preserves the full proposal for history and standalone Markdown output`, () => {
    const message = proposal(name)
    const item = classifyHapiMessage(message)
    assert.equal(item.kind, 'plan')
    assert.equal(item.text, plan)
    assert.equal(item.event.type, 'plan-proposal')
    assert.deepEqual(formatHapiMessageNodes([message]), [`plan #3\n${plan}`])
    assert.equal(formatPlanMarkdown(item), `# Plan\n\n${plan}`)
    assert.equal(extractTextPreview(message.content), plan)
    assert.equal(extractTextPreview(message.content, 100), plan.slice(0, 100))
  })

  test(`${name} stays visible outside collapsed tool summaries`, () => {
    const read = proposal('Read', { file_path: '/repo/README.md' })
    const items = classifyHapiMessages([read, proposal(name)], { collapseActivity: true })
    assert.deepEqual(items.map(item => item.kind), ['activity', 'plan'])
    assert.equal(items[1].text, plan)
  })
}

test('empty or malformed proposal inputs retain the ordinary tool fallback', () => {
  for (const input of [null, {}, { plan: '' }, { plan: '  ' }, { plan: [] }]) {
    const item = classifyHapiMessage(proposal('ExitPlanMode', input))
    assert.equal(item.kind, 'tool-call')
    assert.equal(item.text, 'ExitPlanMode')
  }
  assert.equal(classifyHapiMessage(proposal('SomeOtherTool')).kind, 'tool-call')
})

test('structured progress plans keep their checkbox formatting', () => {
  for (const type of ['plan', 'plan_update']) {
    const message = proposal('ExitPlanMode')
    message.content.content.data = {
      type,
      plan: [{ step: 'Inspect', status: 'completed' }, { step: 'Implement', status: 'in_progress' }],
    }
    assert.equal(classifyHapiMessage(message).text, '- [x] Inspect\n- [~] Implement')
  }
})
