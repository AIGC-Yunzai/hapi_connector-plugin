import test from 'node:test'
import assert from 'node:assert/strict'

import {
  segmentsToChunks,
  buildTextPayload,
  buildMediaPayload,
  eventToSegments,
  extractRefIdx,
  extractQuotedRefIdx,
  parseFaceMessage,
  toUnixSeconds,
} from '../adapter/qqbot/message.js'
import { stripBotMention, computeIntents } from '../adapter/qqbot/constants.js'

test('文本与单个媒体合成一个块，第二个媒体另起一块', () => {
  const chunks = segmentsToChunks([
    '你好',
    { type: 'image', file: 'https://x/a.png' },
    { type: 'text', text: '再见' },
    { type: 'image', file: 'base64://QUJD' },
  ])
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].text, '你好再见')
  assert.equal(chunks[0].media.url, 'https://x/a.png')
  assert.equal(chunks[1].media.base64, 'QUJD')
})

test('at 转成平台标记，at all 被丢弃', () => {
  const [chunk] = segmentsToChunks([
    { type: 'at', qq: '123' },
    { type: 'at', qq: 'all' },
    '在吗',
  ])
  assert.equal(chunk.text, '<qqbot-at-user id="123" />在吗')
})

test('markdown 段并入正文并标记强制 markdown；reply 段取引用 id', () => {
  const [chunk] = segmentsToChunks([
    { type: 'reply', id: 'REFIDX_abc' },
    { type: 'markdown', content: '**加粗**' },
  ])
  assert.equal(chunk.text, '**加粗**')
  assert.equal(chunk.markdown, true)
  assert.equal(chunk.replyId, 'REFIDX_abc')
})

test('纯文本默认走 markdown 通道，关闭后走 content', () => {
  const chunk = { text: 'hi' }
  const md = buildTextPayload(chunk, { messageId: 'm1', msgSeq: 3, markdown: true })
  assert.deepEqual(md, { markdown: { content: 'hi' }, msg_type: 2, msg_id: 'm1', msg_seq: 3 })

  const plain = buildTextPayload(chunk, { messageId: 'm1', msgSeq: 4, markdown: false })
  assert.deepEqual(plain, { content: 'hi', msg_type: 0, msg_id: 'm1', msg_seq: 4 })

  const active = buildTextPayload(chunk, { markdown: true })
  assert.equal(active.msg_id, undefined)
  assert.equal(active.msg_seq, undefined, '主动发送不带 msg_seq')
})

test('频道通道不携带 msg_seq，但仍可带引用', () => {
  const payload = buildTextPayload({ text: 'x' }, { messageId: 'm', msgSeq: 2, allowSeq: false, refIdx: 'REFIDX_1' })
  assert.equal(payload.msg_seq, undefined)
  assert.deepEqual(payload.message_reference, { message_id: 'REFIDX_1' })
})

test('富媒体请求体移除 markdown，正文降级为 content', () => {
  const payload = buildMediaPayload({ fileInfo: 'FI', text: '图注', messageId: 'm1', msgSeq: 1 })
  assert.equal(payload.msg_type, 7)
  assert.deepEqual(payload.media, { file_info: 'FI' })
  assert.equal(payload.content, '图注')
  assert.equal(payload.markdown, undefined)
})

test('入站群消息剥掉三种 @ 标记，只剥当前 bot', () => {
  assert.equal(stripBotMention('before<@bot-123>after', 'bot-123'), 'before after')
  assert.equal(stripBotMention('<@!bot-123> hi', 'bot-123'), ' hi')
  assert.equal(stripBotMention('<qqbot-at-user id="bot-123" /> hi', 'bot-123'), ' hi')
  assert.equal(stripBotMention('<@someone-else> hi', 'bot-123'), '<@someone-else> hi')
})

test('引用消息（message_type=103）把被引内容放进消息链首位', () => {
  const { segments } = eventToSegments(
    {
      message_type: 103,
      msg_elements: [{ id: 'REFIDX_q', content: '上一句', attachments: [] }],
      content: '现在这句',
      attachments: [],
    },
    { botId: 'bot-1', stripMention: true },
  )
  assert.equal(segments[0].type, 'reply')
  assert.equal(segments[0].id, 'REFIDX_q')
  assert.equal(segments[0].text, '上一句')
  assert.equal(segments[1].text, '现在这句')
})

test('附件按 content_type 与后缀分派成 image / record / video / file', () => {
  const { segments } = eventToSegments({
    content: '看',
    attachments: [
      { content_type: 'image/png', url: '//cdn/a.png' },
      { content_type: 'voice', url: 'https://cdn/a.amr' },
      { content_type: 'file', url: 'https://cdn/a.txt', filename: 'a.txt' },
    ],
  })
  assert.equal(segments[1].type, 'image')
  assert.equal(segments[1].file, 'https://cdn/a.png', '协议相对地址要补 https:')
  assert.equal(segments[2].type, 'record')
  assert.equal(segments[3].type, 'file')
})

test('extractRefIdx 只认 msg_idx= 前缀', () => {
  assert.equal(extractRefIdx({ message_scene: { ext: ['a=b', 'msg_idx=REFIDX_9'] } }), 'REFIDX_9')
  assert.equal(extractRefIdx({ message_scene: { ext: [] } }), '')
  assert.equal(extractRefIdx({}), '')
})

test('表情标记解析失败时降级为 [表情]', () => {
  assert.equal(parseFaceMessage('<faceType=1 ext="!!!">'), '[表情]')
  assert.equal(parseFaceMessage('普通文本'), '普通文本')
  const ok = Buffer.from(JSON.stringify({ text: '笑哭' })).toString('base64')
  assert.equal(parseFaceMessage(`<faceType=1 ext="${ok}">`), '[表情:笑哭]')
})

test('intents 与 AstrBot 的四种组合一致', () => {
  assert.equal(computeIntents(), 1107300352)
  assert.equal(computeIntents({ enableGuildDirectMessage: false }), 1107296256)
  assert.equal(computeIntents({ enableGroupC2C: false }), 1073745920)
  assert.equal(computeIntents({ enableGroupC2C: false, enableGuildDirectMessage: false }), 1073741824)
})

test('合并转发段拍平成文本，节点之间空行分隔', () => {
  const chunks = segmentsToChunks({
    type: 'node',
    data: [{ message: '第一段' }, { message: '第二段' }],
  })
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].text, '第一段\n\n第二段')
})

test('转发节点内的消息段数组也能取出正文，图片降级为占位', () => {
  const chunks = segmentsToChunks({
    type: 'node',
    data: [
      { message: [{ type: 'text', text: '看这张' }, { type: 'image', file: 'https://x/a.png' }] },
      { message: { type: 'text', text: '完事' } },
    ],
  })
  assert.equal(chunks[0].text, '看这张\n[图片]\n\n完事')
})

test('嵌套的转发段逐层拍平', () => {
  const chunks = segmentsToChunks({
    type: 'node',
    data: [{ message: { type: 'node', data: [{ message: '里层' }] } }, { message: '外层' }],
  })
  assert.equal(chunks[0].text, '里层\n\n外层')
})

test('转发段与普通文本共存时按块分隔', () => {
  const chunks = segmentsToChunks([
    '开头',
    { type: 'node', data: [{ message: '中间' }] },
    { type: 'text', text: '结尾' },
  ])
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].text, '开头\n\n中间\n\n结尾')
})

test('forward 别名与单对象 data 同样会被拍平，不静默丢消息', () => {
  const alias = segmentsToChunks({ type: 'forward', data: [{ message: '别名' }] })
  assert.equal(alias[0].text, '别名')

  const single = segmentsToChunks({ type: 'node', data: { message: '单节点' } })
  assert.equal(single[0].text, '单节点')
})

test('raw 段仍按对象展开，不受转发段改动影响', () => {
  const chunks = segmentsToChunks({ type: 'raw', data: { type: 'text', text: '原始' } })
  assert.equal(chunks[0].text, '原始')
})

test('引用消息解析出被引正文、REFIDX 与作者昵称', () => {
  const { segments, quote } = eventToSegments({
    message_type: 103,
    content: '这句怎么样',
    msg_elements: [
      {
        msg_idx: 'REFIDX_quoted',
        content: '被引用的原话',
        author: { username: '小明' },
        attachments: [],
      },
    ],
    message_scene: { ext: ['msg_idx=REFIDX_self', 'ref_msg_idx=REFIDX_quoted'] },
  })

  assert.deepEqual(segments[0], {
    type: 'reply',
    id: 'REFIDX_quoted',
    text: '被引用的原话',
    name: '小明',
  })
  assert.deepEqual(quote, { id: 'REFIDX_quoted', text: '被引用的原话', name: '小明' })
})

test('引用元素没有 msg_idx 时退回 message_scene.ext 的 ref_msg_idx', () => {
  const { segments } = eventToSegments({
    message_type: 103,
    content: '看图',
    msg_elements: [{ content: '原图' }],
    message_scene: { ext: ['ref_msg_idx=REFIDX_from_ext', 'msg_idx=REFIDX_self'] },
  })

  assert.equal(segments[0].id, 'REFIDX_from_ext')
  assert.equal(segments[0].text, '原图')
  assert.equal('name' in segments[0], false)
})

test('ref_msg_idx 与元素 msg_idx 冲突时以 ref_msg_idx 为准', () => {
  const { segments, quote } = eventToSegments({
    message_type: 103,
    content: '你说呢',
    msg_elements: [{ msg_idx: 'REFIDX_element', content: '原话', author: { username: '小红' } }],
    message_scene: { ext: ['msg_idx=REFIDX_self', 'ref_msg_idx=REFIDX_ext'] },
  })

  assert.equal(quote.id, 'REFIDX_ext')
  assert.equal(segments[0].id, 'REFIDX_ext')
  assert.equal(segments[0].text, '原话')
})

test('没有引用内容时不会凭空产生 reply 段', () => {
  const { segments, quote } = eventToSegments({ message_type: 0, content: '普通消息' })
  assert.equal(segments.some(item => item.type === 'reply'), false)
  assert.deepEqual(quote, { id: '', text: '', name: '' })
})

test('聊天记录（message_type=102）拍平成正文，不再变成空消息', () => {
  // 转发聊天记录时 content 是空的，正文全在 msg_elements 里；
  // 不拍平的话派发出去就是 e.msg === ''，表现成「机器人毫无反应」
  const { segments, plain } = eventToSegments({
    message_type: 102,
    content: '',
    msg_elements: [
      { content: '=== 消息 1 ===\n[发送者] 甲\n[消息内容] 你好' },
      {
        content: '=== 消息 2 ===\n[发送者] 乙\n[消息内容] 在吗',
        attachments: [{ url: 'https://x/a.png', content_type: 'image/png', filename: 'a.png' }],
      },
    ],
  })

  assert.equal(segments.length, 1, '应该产出正文段，而不是空消息')
  assert.equal(segments[0].type, 'text')
  assert.ok(plain.startsWith('[聊天记录]'))
  assert.ok(plain.includes('你好') && plain.includes('在吗'))
  assert.ok(plain.includes('[图片]'), '记录里的图片降级成占位')
})

test('聊天记录的结构化元素补发送者，嵌套的 msg_elements 递归展开', () => {
  const { plain } = eventToSegments({
    message_type: 102,
    msg_elements: [
      { content: '外层', author: { username: '甲' } },
      {
        content: '内层',
        author: { nickname: '乙' },
        msg_elements: [{ content: '更深一层', author: { username: '丙' } }],
      },
    ],
  })

  assert.ok(plain.includes('甲：外层'))
  assert.ok(plain.includes('乙：内层'))
  assert.ok(plain.includes('丙：更深一层'))
})

test('聊天记录的 content 只是摘要时不重复拼一遍', () => {
  const { plain } = eventToSegments({
    message_type: 102,
    content: '[聊天记录]',
    msg_elements: [{ content: '正文' }],
  })
  assert.equal(plain, '[聊天记录]\n正文')
})

test('并行消息（message_type=101）同样拍平，标题用 [并行消息]', () => {
  const { plain } = eventToSegments({
    message_type: 101,
    msg_elements: [{ content: '一' }, { content: '二' }],
  })
  assert.equal(plain, '[并行消息]\n一\n二')
})

test('普通文本消息不会被容器消息的解析影响', () => {
  const { plain, segments } = eventToSegments({ message_type: 0, content: '在吗' })
  assert.equal(plain, '在吗')
  assert.deepEqual(segments, [{ type: 'text', text: '在吗' }])
})

test('extractQuotedRefIdx 只认 ref_msg_idx，不误取本条消息的 msg_idx', () => {
  assert.equal(extractQuotedRefIdx({ message_scene: { ext: ['msg_idx=REFIDX_self'] } }), '')
  assert.equal(
    extractQuotedRefIdx({ message_scene: { ext: ['ref_msg_idx=REFIDX_q', 'msg_idx=REFIDX_self'] } }),
    'REFIDX_q',
  )
  assert.equal(extractQuotedRefIdx({}), '')
})

test('入站附件同时带 url 与 file，e.img 才拿得到图', () => {
  const { segments } = eventToSegments({
    content: '',
    attachments: [{ url: 'https://x/a.png', content_type: 'image/png', filename: 'a.png' }],
  })
  assert.equal(segments[0].type, 'image')
  assert.equal(segments[0].url, 'https://x/a.png')
  assert.equal(segments[0].file, 'https://x/a.png')

  const stripped = eventToSegments({
    content: '',
    attachments: [{ url: '//x/b.png', content_type: 'image/png', filename: 'b.png' }],
  })
  assert.equal(stripped.segments[0].url, 'https://x/b.png', '协议相对地址补 https')
})

test('群 @ 事件补 at 段，selfId 用 AppID 以匹配 e.self_id', () => {
  const { segments, plain } = eventToSegments(
    {
      content: '<@!BOT_OPENID> #hapi status',
      mentions: [{ id: 'BOT_OPENID', is_you: true, username: '云崽' }],
    },
    {
      botId: 'BOT_OPENID',
      stripMention: true,
      mentionSelf: true,
      mentionName: '云崽',
      selfId: '1906056872',
    },
  )

  assert.deepEqual(segments[0], { type: 'at', qq: '1906056872', name: '云崽' })
  assert.equal(plain, '#hapi status')
  assert.deepEqual(segments[1], { type: 'text', text: '#hapi status' })
})

test('频道消息同样剥掉 <@!id>，否则频道里的指令匹配不上', () => {
  const { plain } = eventToSegments(
    { content: '<@!1234567890> #hapi status' },
    { botId: '1234567890', stripMention: true },
  )
  assert.equal(plain, '#hapi status')
})

test('非引用消息也会读 message_reference，频道引用不再丢', () => {
  const { segments, quote } = eventToSegments({
    content: '看到了',
    message_reference: { message_id: 'CH-MSG-1' },
  })

  assert.deepEqual(segments[0], { type: 'reply', id: 'CH-MSG-1' })
  assert.equal(quote.id, 'CH-MSG-1')
})

test('时间戳兼容 RFC3339 与秒/毫秒，不再产出 NaN', () => {
  const expected = Math.floor(Date.parse('2026-10-28T02:20:00+08:00') / 1000)
  assert.equal(toUnixSeconds('2026-10-28T02:20:00+08:00'), expected)
  assert.equal(toUnixSeconds('1700000000'), 1700000000)
  assert.equal(toUnixSeconds(1700000000000), 1700000000)
  assert.ok(Number.isFinite(toUnixSeconds(undefined)))
})
