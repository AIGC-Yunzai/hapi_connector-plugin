/**
 * 发送索引：记下「机器人发出的消息 id → 它的引用索引」。
 *
 * 平台要求出站引用的 `message_reference.message_id` 是 `REFIDX_` 形态，
 * 但发送结果只回一个 `ROBOT1.0_` 形态的 id；`REFIDX` 藏在响应的
 * `ext_info.ref_idx` 里。想引用「自己刚发的那条」就必须把两者对上，
 * 因此每次发送成功都记一笔。
 *
 * 只在进程内有效：它不是需要备份的状态，重启后引用旧消息退化为
 * 「引用本条」或「不引用」即可。
 */

const DEFAULT_LIMIT = 500

export class RefIndex {
  constructor({ limit = DEFAULT_LIMIT } = {}) {
    const size = Math.floor(Number(limit))
    this.limit = Number.isFinite(size) && size > 0 ? size : DEFAULT_LIMIT
    this.entries = new Map()
  }

  get size() {
    return this.entries.size
  }

  /**
   * @param {string} id 发送响应里的消息 id（`ROBOT1.0_` 形态）
   * @param {string} refIdx 同一响应里的 `ext_info.ref_idx`
   * @returns {boolean} 两个值都齐了才算记住
   */
  remember(id, refIdx) {
    const key = String(id || '').trim()
    const value = String(refIdx || '').trim()
    if (!key || !value) return false

    // 同一个 id 再记一次时挪到最新，避免它因为更早的插入顺序被挤掉
    this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
    return true
  }

  get(id) {
    return this.entries.get(String(id || '').trim()) || ''
  }
}

export default RefIndex
