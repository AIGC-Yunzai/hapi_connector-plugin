import {
  MSG_TYPE,
  MAX_CONTENT_LENGTH,
  QUOTED_MESSAGE_TYPE,
  atMarkup,
  stripBotMention,
} from './constants.js'

/** 把一个 Yunzai segment 规范成 { type, ...fields }（兼容扁平与嵌套两种写法） */
function normalize(segment) {
  if (typeof segment === 'string') return { type: 'text', text: segment }
  if (!segment || typeof segment !== 'object') return { type: 'text', text: String(segment ?? '') }
  // data 可能是对象（raw）也可能是数组（合并转发节点），数组不能展开成对象
  if (segment.type === 'raw' && segment.data && typeof segment.data === 'object' && !Array.isArray(segment.data)) {
    return { ...segment.data }
  }
  // 转发段的 data 是内容本身，展开会把节点列表/节点对象弄丢
  if (segment.type !== 'node' && segment.type !== 'forward'
    && segment.data && typeof segment.data === 'object' && !Array.isArray(segment.data)) {
    return { ...segment.data, type: segment.type }
  }
  return segment
}

/**
 * 合并转发段 → 可读文本。
 *
 * 官方机器人没有合并转发能力，收到 `{ type: 'node', data: [...] }` 只能降级成正文。
 * 不降级的话它会一路走到「不是文本也不是媒体」的分支，整条消息被当成空内容丢掉，
 * 而且不报错——调用方只会收到一个成功的空回复。
 */
function forwardNodeText(node) {
  if (typeof node === 'string') return node.trim()
  if (Array.isArray(node)) return node.map(forwardNodeText).filter(Boolean).join('\n')
  if (!node || typeof node !== 'object') return ''

  // 嵌套的合并转发
  if (node.type === 'node') return flattenForwardNode(node)
  if (node.type === 'text') return String(node.text ?? '').trim()
  if (node.type === 'image') return '[图片]'

  // 转发节点的形状是 { message }（没有 type），message 可能是字符串或消息段数组
  if (node.message !== undefined) return forwardNodeText(node.message)
  if (typeof node.content === 'string') return node.content.trim()
  if (typeof node.text === 'string') return node.text.trim()
  return ''
}

function flattenForwardNode(segment) {
  // data 可能是节点数组，也可能是单个节点对象（部分实现直接写 data: { message }）
  const raw = segment?.data
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  return list.map(forwardNodeText).filter(Boolean).join('\n\n')
}

function isMedia(type) {
  return type === 'image' || type === 'record' || type === 'video' || type === 'file'
}

/**
 * 把媒体 segment 归一成上传所需的三种来源之一。
 * 平台接口同时支持 url 与 base64，本地文件由调用方读成 base64。
 */
function mediaOf(seg) {
  const raw = String(seg.file ?? seg.url ?? '')
  const name = seg.name || seg.filename || ''
  if (raw.startsWith('base64://')) return { kind: seg.type, base64: raw.slice('base64://'.length), name }
  if (/^https?:\/\//i.test(raw)) return { kind: seg.type, url: raw, name }
  return { kind: seg.type, path: raw, name }
}

/**
 * Yunzai 消息段 → 若干发送块。
 *
 * 与 AstrBot 的 `_split_message_chain_by_media` 对齐：每个块最多携带一个媒体，
 * 遇到第二个媒体就另起一块（QQ 一条消息只能带一个富媒体）。
 * `markdown` 段的内容直接并入正文，并打上 forceMarkdown 标记。
 */
export function segmentsToChunks(input) {
  const list = (Array.isArray(input) ? input : [input]).map(normalize)
  const chunks = []
  let current = { text: '', media: null, replyId: '', markdown: false }

  const flush = () => {
    if (current.text.trim() || current.media) {
      // 转发段按块插进正文时会留出空行分隔，收尾把多余的空白剪掉
      current.text = current.text.trim()
      chunks.push(current)
    }
    current = { text: '', media: null, replyId: '', markdown: false }
  }

  /** 转发段是块级内容：前后都留空行，避免和相邻正文黏成一行 */
  const appendBlock = text => {
    if (!text) return
    if (current.text && !current.text.endsWith('\n\n')) {
      current.text += current.text.endsWith('\n') ? '\n' : '\n\n'
    }
    current.text += `${text}\n\n`
  }

  for (const seg of list) {
    // node 是 Yunzai/oicq 的写法，forward 是部分适配器的别名，两种都拍平
    if (seg.type === 'node' || seg.type === 'forward') {
      appendBlock(flattenForwardNode(seg))
      continue
    }
    switch (seg.type) {
      case 'text':
        current.text += String(seg.text ?? '')
        break
      case 'at': {
        const id = String(seg.qq ?? '')
        if (id && id !== 'all') current.text += atMarkup(id)
        break
      }
      case 'markdown':
        current.text += String(seg.content ?? seg.text ?? '')
        current.markdown = true
        break
      case 'reply':
        // 只有 REFIDX_ 形态能直接当引用目标，其余留给调用方回退到本条消息自身
        if (seg.id) current.replyId = String(seg.id)
        break
      case 'face':
        current.text += `[表情:${seg.id ?? ''}]`
        break
      default:
        if (isMedia(seg.type)) {
          if (current.media) flush()
          current.media = mediaOf(seg)
        } else if (seg.text) {
          current.text += String(seg.text)
        }
        break
    }
  }
  flush()
  return chunks
}

/**
 * 单个发送块 → 请求体。
 *
 * @param {object} chunk segmentsToChunks 的产物
 * @param {object} opts
 * @param {string} [opts.messageId] 被动回复的入站消息 id，缺省即主动发送
 * @param {number} [opts.msgSeq] 与 messageId 配对的序号
 * @param {string} [opts.refIdx] 引用目标（REFIDX_ 形态）
 * @param {boolean} [opts.markdown] 是否用 markdown 通道
 * @param {boolean} [opts.allowSeq] 频道通道不带 msg_seq
 */
export function buildTextPayload(chunk, opts = {}) {
  const { messageId = '', msgSeq, refIdx = '', markdown = true, allowSeq = true } = opts
  const text = String(chunk.text || '').slice(0, MAX_CONTENT_LENGTH)
  const payload = markdown
    ? { markdown: { content: text }, msg_type: MSG_TYPE.MARKDOWN }
    : { content: text, msg_type: MSG_TYPE.TEXT }

  if (messageId) payload.msg_id = messageId
  if (messageId && allowSeq && msgSeq) payload.msg_seq = msgSeq
  if (refIdx) payload.message_reference = { message_id: refIdx }
  return payload
}

/** 富媒体请求体：msg_type=7，markdown 必须移除，正文降级成 content 说明 */
export function buildMediaPayload({ fileInfo, text = '', messageId = '', msgSeq, refIdx = '', allowSeq = true }) {
  const payload = { msg_type: MSG_TYPE.MEDIA, media: { file_info: fileInfo } }
  if (text) payload.content = String(text).slice(0, MAX_CONTENT_LENGTH)
  if (messageId) payload.msg_id = messageId
  if (messageId && allowSeq && msgSeq) payload.msg_seq = msgSeq
  if (refIdx) payload.message_reference = { message_id: refIdx }
  return payload
}

/** AstrBot 的 <faceType=... ext="base64(json)"> 表情标记 → 可读文本 */
export function parseFaceMessage(text) {
  return String(text || '').replace(/<faceType=\d+[^>]*>/g, raw => {
    try {
      const ext = /ext="([^"]*)"/.exec(raw)?.[1]
      if (!ext) return '[表情]'
      const json = JSON.parse(Buffer.from(ext, 'base64').toString('utf8'))
      const face = json?.text
      return face ? `[表情:${face}]` : '[表情]'
    } catch {
      return '[表情]'
    }
  })
}

/**
 * 取本条消息的引用 id。
 * 官方要求 message_reference.message_id 用 message_scene.ext 里的 msg_idx（REFIDX_ 形态），
 * 不能用 message.id（ROBOT1.0_ 形态）。
 */
export function extractQuotedRefIdx(raw = {}) {
  const ext = raw?.message_scene?.ext
  if (!Array.isArray(ext)) return ''
  for (const item of ext) {
    const text = String(item || '')
    if (text.startsWith('ref_msg_idx=')) return text.slice('ref_msg_idx='.length).trim()
  }
  return ''
}

export function extractRefIdx(raw = {}) {
  const ext = raw?.message_scene?.ext
  if (!Array.isArray(ext)) return ''
  for (const item of ext) {
    const text = String(item || '')
    if (text.startsWith('msg_idx=')) return text.slice('msg_idx='.length).trim()
  }
  return ''
}

function attachmentToSegment(att = {}) {
  const url = String(att.url || '')
  if (!url) return null
  const type = String(att.content_type || '')
  const name = att.filename || att.name || 'attachment'
  const ext = (name.match(/\.[^.]+$/) || [''])[0].toLowerCase()
  const absolute = /^https?:\/\//i.test(url) ? url : `https://${url.replace(/^\/+/, '')}`

  if (type.startsWith('image')) return { type: 'image', file: absolute, name }
  if (type.startsWith('voice') || type.startsWith('audio') || ['.mp3', '.wav', '.ogg', '.m4a', '.amr', '.silk', '.aac', '.speex', '.flac'].includes(ext))
    return { type: 'record', file: absolute, name }
  if (type.startsWith('video') || ['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext))
    return { type: 'video', file: absolute, name }
  return { type: 'file', file: absolute, name }
}

/**
 * 入站事件 → { segments, plain, quote, attachments }。
 * 群消息剥掉 @ 机器人的标记；引用消息（message_type=103）把被引内容并进消息链。
 */
export function eventToSegments(d = {}, { botId = '', stripMention = false } = {}) {
  const segments = []
  const quote = { id: '', text: '', name: '' }

  if (Number(d.message_type || 0) === QUOTED_MESSAGE_TYPE && Array.isArray(d.msg_elements) && d.msg_elements.length) {
    const element = d.msg_elements[0] || {}
    // 被引用消息的 REFIDX 有两个来源：message_scene.ext 的 ref_msg_idx 语义最直白，
    // 元素自身的 msg_idx 次之，id/message_id 是历史写法。
    quote.id = String(extractQuotedRefIdx(d) || element.msg_idx || element.id || element.message_id || '')
    quote.text = parseFaceMessage(String(element.content || '').trim())
    quote.name = String(element.author?.username || element.author?.nickname || '').trim()
    if (quote.id || quote.text) {
      const replySegment = { type: 'reply', id: quote.id, text: quote.text }
      // 云崽的 reply 段没有昵称字段，这里带上，供引用文本拼「谁说的」
      if (quote.name) replySegment.name = quote.name
      segments.push(replySegment)
    }
    for (const att of element.attachments || []) {
      const seg = attachmentToSegment(att)
      if (seg) segments.push(seg)
    }
  }

  let plain = String(d.content || '')
  if (stripMention && botId) plain = stripBotMention(plain, botId)
  plain = parseFaceMessage(plain.trim())
  if (plain) segments.push({ type: 'text', text: plain })

  for (const att of d.attachments || []) {
    const seg = attachmentToSegment(att)
    if (seg) segments.push(seg)
  }

  return { segments, plain, quote }
}
