/**
 * 群 / 频道元数据缓存。
 *
 * 群名、成员数这类信息不在每条消息事件里，只能单独查接口；按 AstrBot 的口径：
 * 查询成功缓存 1 小时，失败（返回空）缓存 5 分钟，避免接口挂了之后每条消息都卡一次超时。
 * 同一个 key 的并发请求合并成一次，缓存满了淘汰最早写入的一条。
 */
const HOUR = 60 * 60 * 1000
const FIVE_MINUTES = 5 * 60 * 1000

export class InfoCache {
  constructor({ ttl = HOUR, failTtl = FIVE_MINUTES, max = 1024, now = () => Date.now() } = {}) {
    this.ttl = ttl
    this.failTtl = failTtl
    this.max = max
    this.now = now
    this.map = new Map()
    this.pending = new Map()
  }

  /**
   * 取缓存；没有就调 loader。
   * 查询失败不抛给调用方——元数据缺了不该影响消息派发。
   * @returns {Promise<object|null>}
   */
  async get(key, loader) {
    const hit = this.map.get(key)
    if (hit && hit.expiresAt > this.now()) return hit.value
    const inflight = this.pending.get(key)
    if (inflight) return inflight

    const task = (async () => {
      try {
        const value = await loader()
        this.#set(key, value || null, value ? this.ttl : this.failTtl)
        return value || null
      } catch {
        this.#set(key, null, this.failTtl)
        return null
      } finally {
        this.pending.delete(key)
      }
    })()

    this.pending.set(key, task)
    return task
  }

  /** 同步读缓存（不触发请求），给 pickGroup 这类同步场景用 */
  peek(key) {
    const hit = this.map.get(key)
    return hit && hit.expiresAt > this.now() ? hit.value : null
  }

  #set(key, value, ttl) {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, { value, expiresAt: this.now() + ttl })
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value)
  }

  clear() {
    this.map.clear()
    this.pending.clear()
  }
}
