import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '../..')
const configDir = path.join(pluginRoot, 'config', 'config')
const configPath = path.join(configDir, 'qqbot.yaml')

const DEFAULTS = {
  markdown: true,
  enable_group_c2c: true,
  enable_guild_direct_message: true,
  enabled: true,
  remark: '',
}

function normalize(raw = {}) {
  return {
    appid: String(raw.appid || '').trim(),
    secret: String(raw.secret || '').trim(),
    markdown: raw.markdown !== false,
    enable_group_c2c: raw.enable_group_c2c !== false,
    enable_guild_direct_message: raw.enable_guild_direct_message !== false,
    enabled: raw.enabled !== false,
    remark: String(raw.remark || ''),
    created_at: raw.created_at || '',
  }
}

/**
 * 机器人账号表。
 *
 * 「登录/退出/删除」三个动作分别对应：enabled=true 并连上网关、enabled=false 并断开、
 * 从表里删掉这条记录。凭证只有 AppID 与 AppSecret，删掉即彻底解除绑定。
 */
class AccountStore {
  constructor(file = configPath) {
    this.file = file
    this.accounts = new Map()
    this.loadedAt = 0
  }

  load() {
    this.accounts.clear()
    if (!fs.existsSync(this.file)) return this
    const raw = YAML.parse(fs.readFileSync(this.file, 'utf8')) || {}
    for (const item of raw.accounts || []) {
      const account = normalize(item)
      if (account.appid && account.secret) this.accounts.set(account.appid, account)
    }
    this.loadedAt = Date.now()
    return this
  }

  reload() {
    return this.load()
  }

  list() {
    if (!this.loadedAt) this.load()
    return [...this.accounts.values()]
  }

  get(appid) {
    if (!this.loadedAt) this.load()
    return this.accounts.get(String(appid)) || null
  }

  upsert(input) {
    if (!this.loadedAt) this.load()
    const account = normalize({ ...DEFAULTS, ...input })
    if (!account.appid) throw new Error('账号缺少 appid')
    if (!account.secret) throw new Error('账号缺少 secret')
    const previous = this.accounts.get(account.appid)
    account.created_at = previous?.created_at || new Date().toISOString()
    this.accounts.set(account.appid, account)
    this.save()
    return account
  }

  setEnabled(appid, enabled) {
    const account = this.get(appid)
    if (!account) return null
    account.enabled = Boolean(enabled)
    this.save()
    return account
  }

  remove(appid) {
    if (!this.loadedAt) this.load()
    const existed = this.accounts.delete(String(appid))
    if (existed) this.save()
    return existed
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const payload = { accounts: [...this.accounts.values()] }
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, YAML.stringify(payload), 'utf8')
    fs.renameSync(tmp, this.file)
    this.loadedAt = Date.now()
  }
}

export const accountStore = new AccountStore()
export { AccountStore, configPath }
export default accountStore
