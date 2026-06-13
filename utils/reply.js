const DIRECT_REPLY_LIMIT = 300
const MESSAGE_LIMIT = 7000
const SAFE_NODE_LIMIT = 6800

export async function smartReply(e, msg = '', quote = false, data = {}) {
  if (!e?.reply || msg === undefined || msg === null || msg === '') return false

  if (Array.isArray(msg) && msg.every(item => typeof item === 'string')) {
    return replyForward(e, msg, data)
  }

  if (typeof msg !== 'string') return e.reply(msg, quote, data)
  if (msg.length <= DIRECT_REPLY_LIMIT) return e.reply(msg, quote, data)

  return replyForward(e, splitTextToNodes(msg), data)
}

function splitTextToNodes(text) {
  const nodes = []
  const paragraphs = String(text).split(/\n{2,}/)
  let current = ''

  for (const paragraph of paragraphs) {
    const piece = paragraph.trim()
    if (!piece) continue
    if (piece.length > SAFE_NODE_LIMIT) {
      if (current) {
        nodes.push(current)
        current = ''
      }
      nodes.push(...splitLongText(piece, SAFE_NODE_LIMIT))
      continue
    }
    const next = current ? `${current}\n\n${piece}` : piece
    if (next.length > SAFE_NODE_LIMIT) {
      nodes.push(current)
      current = piece
    } else {
      current = next
    }
  }

  if (current) nodes.push(current)
  return nodes.length ? nodes : ['(空)']
}

function splitLongText(text, size) {
  const ret = []
  for (let i = 0; i < text.length; i += size) ret.push(text.slice(i, i + size))
  return ret
}

function normalizeNodes(nodes) {
  return nodes.flatMap(node => splitTextToNodes(String(node))).filter(Boolean)
}

function groupNodes(nodes) {
  const groups = []
  let current = []
  let total = 0
  for (const node of normalizeNodes(nodes)) {
    const len = node.length
    if (current.length && total + len > MESSAGE_LIMIT) {
      groups.push(current)
      current = []
      total = 0
    }
    current.push(node)
    total += len
  }
  if (current.length) groups.push(current)
  return groups
}

async function replyForward(e, nodes, data = {}) {
  const groups = groupNodes(nodes)
  if (!groups.length) return false

  if (global.Bot?.makeForwardArray) {
    let ret = true
    for (const group of groups) {
      ret = await e.reply(global.Bot.makeForwardArray(group), false, data)
    }
    return ret
  }

  let ret = true
  for (const group of groups) {
    for (const node of group) ret = await e.reply(node.slice(0, MESSAGE_LIMIT), false, data)
  }
  return ret
}
