/**
 * 从 HAPI 消息内容里提取由 MCP: Hapi Display Image 产生的 generated-image。
 *
 * HAPI 当前把这类消息存成：
 *   { role: 'agent', content: { type: 'codex', data: { type: 'generated-image', imageId, ... } } }
 * 老版本或其它 agent 也可能存在额外包装，所以这里用递归提取，避免耦合单一结构。
 */
export function collectGeneratedImages(value) {
  const found = new Map()
  const visited = new Set()

  const visit = node => {
    if (!node || typeof node !== 'object') return
    if (visited.has(node)) return
    visited.add(node)

    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }

    const type = normalizeImageType(node.type ?? node.kind)
    if (type === 'generated-image') {
      const imageId = firstString(
        node.imageId,
        node.image_id,
        node.generatedImageId,
        node.generated_image_id,
      )
      if (imageId && !found.has(imageId)) {
        found.set(imageId, {
          imageId,
          fileName: firstString(node.fileName, node.file_name, node.filename, node.name) || '图片',
          mimeType: firstString(node.mimeType, node.mime_type, node.mediaType, node.media_type) || '',
        })
      }
    }

    for (const child of Object.values(node)) visit(child)
  }

  visit(value)
  return [...found.values()]
}

export function collectGeneratedImagesFromMessages(messages) {
  const found = new Map()
  for (const msg of Array.isArray(messages) ? messages : []) {
    for (const img of collectGeneratedImages(msg?.content ?? msg)) {
      if (!found.has(img.imageId)) found.set(img.imageId, img)
    }
  }
  return [...found.values()]
}

/**
 * QQ/OneBot 对 base64:// 图片兼容性通常比直接传 Buffer 更好。
 * 图片仍作为独立 image segment 发送，不参与 markdown 图片渲染。
 */
export function imageSegmentFromBuffer(buffer, image = {}) {
  if (!buffer) return null
  const api = globalThis.segment || global.segment
  if (!api?.image) throw new Error('segment.image 不可用')
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  return api.image(`base64://${raw.toString('base64')}`, image.fileName)
}

function normalizeImageType(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/_/g, '-')
    : ''
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}
