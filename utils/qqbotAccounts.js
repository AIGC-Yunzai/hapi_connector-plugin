/**
 * 锅巴账号卡片的读写桥接。
 *
 * 账号表是独立文件（`config/config/qqbot.yaml`），不并入主配置。锅巴只能看到
 * 一份「卡片数组」，所以每次保存都是拿卡片的快照跟账号表求差集：
 * - 只在旧表里 → 删除并断连（AppSecret 一起抹掉）
 * - 两边都有   → 只改备注、启用状态与发送格式
 * - 只在提交里 → 忽略（新增只能走扫码或命令行）
 *
 * AppSecret 既不出现在卡片里，也不会被这里写回——它只存在于账号表。
 */

function enabledOf(account) {
  return account?.enabled !== false
}

function markdownOf(account) {
  return account?.markdown !== false
}

function appidOf(value) {
  return String(value ?? '').trim()
}

/**
 * 账号表 → 卡片数组。
 *
 * @param {Array} accounts accountStore.list() 的结果
 * @param {(appid: string) => { online?: boolean, ready?: boolean }} [statusOf]
 * @returns {Array<{ appid: string, remark: string, enabled: boolean, markdown: boolean, status: string }>}
 */
export function buildQQBotAccountCards(accounts, statusOf = () => ({})) {
  return (Array.isArray(accounts) ? accounts : []).map(account => {
    const appid = appidOf(account?.appid)
    return {
      appid,
      remark: String(account?.remark || ''),
      enabled: enabledOf(account),
      markdown: markdownOf(account),
      status: accountStatusLabel(account, statusOf(appid) || {}),
    }
  })
}

/**
 * 账号的展示状态。停用优先于连接状态——停用的账号本来就不该在连。
 *
 * @param {object} account 账号表里的一条
 * @param {{ online?: boolean, ready?: boolean }} [status] 适配器实时状态
 * @returns {'已停用' | '在线' | '连接中' | '离线'}
 */
export function accountStatusLabel(account, status = {}) {
  if (!enabledOf(account)) return '已停用'
  if (status.ready) return '在线'
  if (status.online) return '连接中'
  return '离线'
}

/**
 * 求「账号表」与「提交上来的卡片」的差集。
 *
 * @param {Array} current 当前账号表
 * @param {Array} submitted 锅巴提交的卡片数组
 * @returns {{
 *   remove: string[],
 *   update: Array<{ appid: string, remark: string, enabled: boolean, markdown: boolean, markdownChanged: boolean, reconnect: boolean }>,
 *   ignored: string[],
 * }}
 */
export function diffQQBotAccounts(current, submitted) {
  const currentMap = new Map()
  for (const account of Array.isArray(current) ? current : []) {
    const appid = appidOf(account?.appid)
    if (appid) currentMap.set(appid, account)
  }

  const submittedMap = new Map()
  for (const card of Array.isArray(submitted) ? submitted : []) {
    const appid = appidOf(card?.appid)
    if (!appid) continue
    // 同一 AppID 出现多张卡时后写覆盖先写
    submittedMap.set(appid, card)
  }

  const remove = []
  const update = []
  const ignored = []

  for (const appid of submittedMap.keys()) {
    if (!currentMap.has(appid)) ignored.push(appid)
  }

  for (const [appid, account] of currentMap) {
    const card = submittedMap.get(appid)
    if (!card) {
      remove.push(appid)
      continue
    }
    const remark = card.remark === undefined ? String(account.remark || '') : String(card.remark ?? '')
    const enabled = card.enabled === undefined ? enabledOf(account) : Boolean(card.enabled)
    const markdown = card.markdown !== false
    const remarkChanged = remark !== String(account.remark || '')
    const enabledChanged = enabled !== enabledOf(account)
    const markdownChanged = markdown !== markdownOf(account)
    if (!remarkChanged && !enabledChanged && !markdownChanged) continue
    update.push({
      appid,
      remark,
      enabled,
      markdown,
      markdownChanged,
      // 发送格式不用重连，只有启停才动连接
      reconnect: enabledChanged,
    })
  }

  return { remove, update, ignored }
}

/**
 * 把差集落到账号表与连接上。
 *
 * @param {{ remove: string[], update: Array }} diff
 * @param {{
 *   remove: (appid: string) => Promise<any>,
 *   updateAccount: (appid: string, patch: object) => any,
 *   login: (appid: string) => Promise<any>,
 *   logout: (appid: string) => Promise<any>,
 * }} adapter
 * @returns {Promise<{ removed: string[], updated: string[], errors: Array<{ appid: string, message: string }> }>}
 */
export async function applyQQBotAccountDiff(diff, adapter) {
  const removed = []
  const updated = []
  const errors = []

  for (const appid of diff?.remove || []) {
    try {
      await adapter.remove(appid)
      removed.push(appid)
    } catch (err) {
      errors.push({ appid, message: err?.message || String(err) })
    }
  }

  for (const item of diff?.update || []) {
    try {
      adapter.updateAccount(item.appid, {
        remark: item.remark,
        enabled: item.enabled,
        markdown: item.markdown,
      })
      // 启停要立刻生效：关就断开，开就重连
      if (item.reconnect) {
        if (item.enabled) await adapter.login(item.appid)
        else await adapter.logout(item.appid)
      }
      updated.push(item.appid)
    } catch (err) {
      errors.push({ appid: item.appid, message: err?.message || String(err) })
    }
  }

  return { removed, updated, errors }
}
