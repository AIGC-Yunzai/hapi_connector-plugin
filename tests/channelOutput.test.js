import assert from 'node:assert/strict'
import test from 'node:test'
import { OUTPUT_IMAGE, OUTPUT_MARKDOWN, planQQBotOutput } from '../utils/channelOutput.js'

const HEADER = '会话 A'
const BODY = ['assistant #1\n正文一', 'assistant #2\n正文二']

const official = (markdownOutput, summaryMarkdown = true) => ({
  isOfficial: true,
  outputLevel: 'simple',
  markdownOutput,
  summaryMarkdown,
})

function kinds(plans) {
  return plans.map(plan => plan.kind)
}

test('text mode keeps everything in one native markdown message', () => {
  const plans = planQQBotOutput(BODY, 1, HEADER, official('text'))

  assert.deepEqual(kinds(plans), [OUTPUT_MARKDOWN])
  assert.equal(plans[0].content, '会话 A\n\n**assistant #1**\n\n正文一\n\n**assistant #2**\n\n正文二')
})

test('image mode splits the summary into text and the rest into a picture', () => {
  const plans = planQQBotOutput(BODY, 1, HEADER, official('image'))

  assert.deepEqual(kinds(plans), [OUTPUT_MARKDOWN, OUTPUT_IMAGE])
  // 摘要单独发文本：含抬头与摘要，不含正文
  assert.equal(plans[0].content, '会话 A\n\n**assistant #2**\n\n正文二')
  // 图片里只有正文，不重复摘要
  assert.match(plans[1].markdown, /正文一/)
  assert.match(plans[1].markdown, /会话 A/)
  assert.doesNotMatch(plans[1].markdown, /正文二/)
})

test('image mode sends no picture when the batch is only the summary', () => {
  const plans = planQQBotOutput(['assistant #2\n只有摘要'], 0, HEADER, official('image'))

  assert.deepEqual(kinds(plans), [OUTPUT_MARKDOWN])
  assert.equal(plans[0].content, '会话 A\n\n**assistant #2**\n\n只有摘要')
})

test('both mode sends the full text plus a picture without the summary', () => {
  const plans = planQQBotOutput(BODY, 0, HEADER, official('both'))

  assert.deepEqual(kinds(plans), [OUTPUT_MARKDOWN, OUTPUT_IMAGE])
  assert.match(plans[0].content, /正文一/)
  assert.match(plans[0].content, /正文二/)
  assert.doesNotMatch(plans[1].markdown, /正文一/)
  assert.match(plans[1].markdown, /正文二/)
})

test('turning the switch off restores the unsplit behaviour', () => {
  const image = planQQBotOutput(BODY, 1, HEADER, official('image', false))
  assert.deepEqual(kinds(image), [OUTPUT_IMAGE])
  assert.match(image[0].markdown, /正文一/)
  assert.match(image[0].markdown, /正文二/)

  const both = planQQBotOutput(BODY, 1, HEADER, official('both', false))
  assert.deepEqual(kinds(both), [OUTPUT_MARKDOWN, OUTPUT_IMAGE])
  assert.match(both[0].content, /正文一/)
  assert.match(both[1].markdown, /正文一/)
})

test('a batch without a summary is never split', () => {
  for (const mode of ['text', 'image', 'both']) {
    const plans = planQQBotOutput(BODY, -1, HEADER, official(mode))
    const image = plans.filter(plan => plan.kind === OUTPUT_IMAGE)
    if (mode === 'text') assert.deepEqual(kinds(plans), [OUTPUT_MARKDOWN])
    else assert.ok(image.length === 1, mode)
    if (image.length) assert.match(image[0].markdown, /正文二/)
  }
})

test('an out-of-range summary index is ignored', () => {
  const plans = planQQBotOutput(BODY, 9, HEADER, official('image'))
  assert.deepEqual(kinds(plans), [OUTPUT_IMAGE])
})

test('empty batches produce nothing, and blank nodes are dropped', () => {
  assert.deepEqual(planQQBotOutput([], 0, HEADER, official('both')), [])
  assert.deepEqual(planQQBotOutput(null, 0, HEADER, official('both')), [])
  assert.deepEqual(planQQBotOutput(['  ', ''], 0, HEADER, official('both')), [])
})

test('image blocks carry a native-markdown fallback for render failures', () => {
  const [image] = planQQBotOutput(BODY, -1, HEADER, official('image'))

  // 渲染用的版本按图片阅读习惯用分隔线；兜底文本不能带 `---`（QQ 原生 markdown 不认）
  assert.match(image.markdown, /---/)
  assert.doesNotMatch(image.text, /---/)
  assert.equal(image.text, '会话 A\n\n**assistant #1**\n\n正文一\n\n**assistant #2**\n\n正文二')
})

test('a missing header does not leave an empty bold line', () => {
  const plans = planQQBotOutput(['assistant #1\n正文'], 0, '', official('text'))
  assert.equal(plans[0].content, '**assistant #1**\n\n正文')
})
