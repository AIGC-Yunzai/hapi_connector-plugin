import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractNotifySummary,
  matchNotifySummaryLine,
  selectSummaryItem,
  splitNotifySummary,
  stripNotifySummaryFooter,
} from '../utils/notifySummary.js'
import { classifyHapiMessages, formatHapiMessageNodes } from '../utils/hapiMessages.js'

const FOOTER = 'AGENT_NOTIFY_SUMMARY {"version":1,"agent":"claude","status":"done","action":"edit","summary":"改了 3 个文件"}'

function reply(seq, text) {
  return {
    seq,
    content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: text } } },
  }
}

test('a well-formed footer is split off the body', () => {
  const body = '## 结论\n\n改了 3 个文件，测试全绿。'
  const text = `${body}\n\n${FOOTER}`

  assert.deepEqual(splitNotifySummary(text), {
    visibleText: body,
    summary: {
      version: 1,
      agent: 'claude',
      status: 'done',
      action: 'edit',
      summary: '改了 3 个文件',
    },
  })
  assert.equal(stripNotifySummaryFooter(text), body)
  assert.equal(extractNotifySummary(text)?.status, 'done')
})

test('trailing blank lines do not hide the footer', () => {
  assert.equal(stripNotifySummaryFooter(`正文\n${FOOTER}\n\n  \n`), '正文')
})

test('a glued footer keeps the prose that shares its line', () => {
  // agent 有时省掉换行：Done.AGENT_NOTIFY_SUMMARY {…}
  const text = `正文第一段\n\n完成。${FOOTER}`
  assert.equal(stripNotifySummaryFooter(text), '正文第一段\n\n完成。')
  assert.equal(extractNotifySummary(text)?.status, 'done')
})

test('an indented footer is still a footer', () => {
  const text = `正文\n    ${FOOTER}`
  assert.equal(stripNotifySummaryFooter(text), '正文')
})

test('a prose mention of the token is not a footer', () => {
  // 前缀非空且紧邻空白 → 叙述里的举例，不剥
  const text = `正文\n\nExample: ${FOOTER}`
  assert.equal(matchNotifySummaryLine(`Example: ${FOOTER}`), null)
  assert.equal(stripNotifySummaryFooter(text), text)
  assert.equal(extractNotifySummary(text), null)
})

test('a footer that is not the last non-empty line is left alone', () => {
  const text = `正文\n${FOOTER}\n后面还有话。`
  assert.equal(stripNotifySummaryFooter(text), text)
})

test('malformed JSON is left alone', () => {
  for (const bad of [
    '正文\nAGENT_NOTIFY_SUMMARY {status:done}',
    '正文\nAGENT_NOTIFY_SUMMARY {"status":"done"',
    '正文\nAGENT_NOTIFY_SUMMARY [1,2,3]',
    '正文\nAGENT_NOTIFY_SUMMARY {}extra',
  ]) {
    assert.equal(stripNotifySummaryFooter(bad), bad)
    assert.equal(extractNotifySummary(bad), null)
  }
})

test('non-string and empty input pass through unchanged', () => {
  for (const value of [null, undefined, '', 0, {}]) {
    assert.equal(stripNotifySummaryFooter(value), value)
    assert.equal(extractNotifySummary(value), null)
  }
})

test('selectSummaryItem prefers the reply that carries a footer', () => {
  const items = classifyHapiMessages([reply(1, `中间结论\n\n${FOOTER}`), reply(2, '最后一句补充')])
  const picked = selectSummaryItem(items)

  assert.equal(picked.seq, 1)
  assert.equal(picked.text, '中间结论')
  assert.equal(picked.notifySummary.status, 'done')
})

test('selectSummaryItem falls back to the last assistant-reply', () => {
  const items = classifyHapiMessages([reply(1, '第一句'), reply(2, '最后一句话')])
  const picked = selectSummaryItem(items)

  assert.equal(picked.seq, 2)
  assert.equal(picked.text, '最后一句话')
  assert.equal(picked.notifySummary, undefined)
})

test('selectSummaryItem is empty when the batch has no assistant-reply', () => {
  const items = classifyHapiMessages([
    { seq: 1, content: { role: 'agent', content: { type: 'codex', data: { type: 'reasoning', message: '思考中' } } } },
  ])
  assert.equal(selectSummaryItem(items), null)
  assert.equal(selectSummaryItem([]), null)
  assert.equal(selectSummaryItem(null), null)
})

test('classification strips the footer so pushed nodes never show it', () => {
  const message = reply(7, `## 收尾\n\n都改完了，测试 86 项通过。\n\n${FOOTER}`)
  const [item] = classifyHapiMessages([message])

  assert.equal(item.text, '## 收尾\n\n都改完了，测试 86 项通过。')
  assert.equal(item.notifySummary.status, 'done')
  assert.deepEqual(formatHapiMessageNodes([message]), ['assistant #7\n## 收尾\n\n都改完了，测试 86 项通过。'])
  assert.ok(!formatHapiMessageNodes([message])[0].includes('AGENT_NOTIFY_SUMMARY'))
})

test('a reply that is nothing but a footer produces no visible node', () => {
  const message = reply(8, FOOTER)
  const [item] = classifyHapiMessages([message])

  assert.equal(item.text, '')
  assert.equal(item.notifySummary.status, 'done')
  assert.deepEqual(formatHapiMessageNodes([message]), ['(暂无可显示的消息)'])
})
