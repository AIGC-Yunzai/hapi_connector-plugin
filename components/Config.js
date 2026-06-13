import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { pluginRoot } from '../model/path.js'

class Config {
  constructor() {
    this.cache = null
    this.configPath = path.join(pluginRoot, 'config', 'config', 'hapi.yaml')
    this.defaultPath = path.join(pluginRoot, 'config', 'hapi_default.yaml')
    this.ensureFiles()
    this.watch()
  }

  ensureFiles() {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true })
    if (!fs.existsSync(this.configPath)) {
      fs.copyFileSync(this.defaultPath, this.configPath)
      logger.mark('[hapi-connector] 已生成默认配置 config/config/hapi.yaml')
    }
  }

  getDefault() {
    return YAML.parse(fs.readFileSync(this.defaultPath, 'utf8')) || {}
  }

  syncDefault(current, def) {
    const next = { ...current }
    for (const [key, value] of Object.entries(def)) {
      if (!(key in next)) next[key] = value
    }
    for (const key of Object.keys(next)) {
      if (!(key in def)) delete next[key]
    }
    return next
  }

  getConfig() {
    if (this.cache) return structuredClone(this.cache)
    try {
      const def = this.getDefault()
      const raw = YAML.parse(fs.readFileSync(this.configPath, 'utf8')) || {}
      this.cache = this.syncDefault(raw, def)
      if (JSON.stringify(raw) !== JSON.stringify(this.cache)) this.setConfig(this.cache)
      return structuredClone(this.cache)
    } catch (err) {
      logger.error('[hapi-connector] 读取配置失败，将使用默认配置', err)
      this.cache = this.getDefault()
      return structuredClone(this.cache)
    }
  }

  setConfig(config) {
    this.cache = structuredClone(config)
    fs.writeFileSync(this.configPath, YAML.stringify(this.cache), 'utf8')
    return true
  }

  updateConfig(key, value) {
    const config = this.getConfig()
    config[key] = value
    this.setConfig(config)
    return config
  }

  watch() {
    try {
      fs.watch(this.configPath, () => {
        this.cache = null
      })
    } catch (err) {
      logger.debug('[hapi-connector] 配置监听失败', err)
    }
  }
}

export default new Config()
