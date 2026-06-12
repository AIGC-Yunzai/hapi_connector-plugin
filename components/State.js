import fs from 'node:fs'
import path from 'node:path'
import { pluginData } from '../model/path.js'

const statePath = path.join(pluginData, 'state.json')

function blankState() {
  return {
    windows: {},
    sessionOwners: {},
    users: {},
  }
}

class State {
  constructor() {
    this.data = blankState()
    this.eventCache = new Map()
    this.load()
  }

  load() {
    try {
      fs.mkdirSync(pluginData, { recursive: true })
      if (fs.existsSync(statePath)) {
        this.data = { ...blankState(), ...JSON.parse(fs.readFileSync(statePath, 'utf8')) }
      }
    } catch (err) {
      logger.error('[hapi-connector] 读取状态失败', err)
      this.data = blankState()
    }
  }

  save() {
    fs.mkdirSync(pluginData, { recursive: true })
    fs.writeFileSync(statePath, JSON.stringify(this.data, null, 2), 'utf8')
  }

  windowKey(e) {
    const self = String(e.self_id || e.bot?.uin || 'unknown')
    if (e.isGroup) return `onebot:${self}:group:${e.group_id}`
    return `onebot:${self}:private:${e.user_id}`
  }

  userKey(e) {
    return String(e.user_id || e.sender?.user_id || 'unknown')
  }

  rememberEvent(e) {
    this.eventCache.set(this.windowKey(e), e)
  }

  setCurrent(e, sid, flavor = '') {
    const key = this.windowKey(e)
    this.data.windows[key] = { ...(this.data.windows[key] || {}), currentSession: sid, flavor }
    this.data.sessionOwners[sid] = key
    this.save()
  }

  clearSession(sid) {
    delete this.data.sessionOwners[sid]
    for (const win of Object.values(this.data.windows)) {
      if (win.currentSession === sid) {
        delete win.currentSession
        delete win.flavor
      }
    }
    this.save()
  }

  currentSid(e) {
    const key = this.windowKey(e)
    const direct = this.data.windows[key]?.currentSession
    if (direct) return direct
    const user = this.data.users[this.userKey(e)] || {}
    const primary = user.primaryWindow
    return primary ? this.data.windows[primary]?.currentSession : ''
  }

  currentFlavor(e) {
    const key = this.windowKey(e)
    return this.data.windows[key]?.flavor || ''
  }

  bindPrimary(e, flavor = '') {
    const user = this.userKey(e)
    const key = this.windowKey(e)
    this.data.users[user] ||= {}
    if (flavor) {
      this.data.users[user].flavorPrimaryWindows ||= {}
      this.data.users[user].flavorPrimaryWindows[flavor] = key
    } else {
      this.data.users[user].primaryWindow = key
    }
    this.save()
  }

  resetBindings(e) {
    const key = this.windowKey(e)
    for (const [sid, owner] of Object.entries(this.data.sessionOwners)) {
      if (owner === key) delete this.data.sessionOwners[sid]
    }
    delete this.data.windows[key]
    this.save()
  }

  visibleSessions(e, sessions) {
    const key = this.windowKey(e)
    const user = this.data.users[this.userKey(e)] || {}
    const primary = user.primaryWindow
    const flavorRoutes = user.flavorPrimaryWindows || {}
    const hasAnyRoute = Boolean(primary || Object.keys(flavorRoutes).length || Object.keys(this.data.sessionOwners).length)

    if (!hasAnyRoute) return sessions

    return sessions.filter(session => {
      const sid = session.id
      const owner = this.data.sessionOwners[sid]
      if (owner) return owner === key
      const flavor = session.metadata?.flavor || ''
      if (flavor && flavorRoutes[flavor]) return flavorRoutes[flavor] === key
      if (primary) return primary === key
      return true
    })
  }

  windowForSession(session) {
    const sid = session?.id
    if (!sid) return ''
    const owner = this.data.sessionOwners[sid]
    if (owner) return owner

    const flavor = session.metadata?.flavor || ''
    for (const user of Object.values(this.data.users)) {
      if (flavor && user.flavorPrimaryWindows?.[flavor]) return user.flavorPrimaryWindows[flavor]
      if (user.primaryWindow) return user.primaryWindow
    }
    return ''
  }

  formatWindowKey(key) {
    const parts = String(key).split(':')
    if (parts.length < 4) return key || '(未绑定)'
    return parts[2] === 'group' ? `群 ${parts[3]}` : `私聊 ${parts[3]}`
  }
}

export default new State()
