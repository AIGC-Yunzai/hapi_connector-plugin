import plugin from '../../../lib/plugins/plugin.js'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { exec, execSync } = require('node:child_process')
const pluginName = 'hapi_connector-plugin'
const pluginDir = `./plugins/${pluginName}/`
let updating = false

export class hapiUpdate extends plugin {
  constructor() {
    super({
      name: 'hapi-connector-更新插件',
      event: 'message',
      priority: 1007,
      rule: [
        {
          reg: '^#hapi\\s*((插件)?(强制)?更新|update)(\\s+(dev|DEV|main|MAIN))?$',
          fnc: 'update',
          permission: 'master',
        },
      ],
    })
  }

  async update() {
    if (updating) return this.reply('已有更新命令正在执行，请稍后再试')
    if (!(await this.checkGit())) return true

    const msg = String(this.e.msg || '')
    const force = msg.includes('强制')
    const branch = msg.match(/\s+(dev|DEV|main|MAIN)\s*$/)?.[1]?.toLowerCase() || ''

    this.oldCommitId = await this.getCommitId().catch(() => '')
    updating = true
    try {
      await this.runUpdate(force, branch)
    } finally {
      updating = false
    }

    if (this.isUp) setTimeout(() => this.restart(), 2000)
    return true
  }

  async runUpdate(force, branch) {
    let command = ''
    if (force && branch) {
      command = `git -C ${pluginDir} config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*" && git -C ${pluginDir} fetch origin && git -C ${pluginDir} reset --hard HEAD && git -C ${pluginDir} clean -fd && git -C ${pluginDir} checkout ${branch} && git -C ${pluginDir} fetch --all && git -C ${pluginDir} reset --hard origin/${branch}`
      await this.reply(`正在执行 ${branch} 分支强制更新，请稍等`)
    } else if (force) {
      command = `git -C ${pluginDir} reset --hard HEAD && git -C ${pluginDir} clean -fd && git -C ${pluginDir} checkout . && git -C ${pluginDir} fetch --all && git -C ${pluginDir} reset --hard @{u}`
      await this.reply('正在执行强制更新，请稍等')
    } else {
      command = `git -C ${pluginDir} pull --no-rebase`
      await this.reply('正在执行更新，请稍等')
    }

    const ret = await this.exec(command)
    if (ret.error) {
      logger.mark(`${this.e.logFnc} 更新失败：${pluginName}`)
      await this.gitErr(ret.error, ret.stdout)
      return false
    }

    const time = await this.getTime().catch(() => '获取时间失败')
    if (/(Already up[ -]to[ -]date|已经是最新的)/i.test(ret.stdout)) {
      await this.reply(`${pluginName}${branch ? `(${branch}分支)` : ''} 已经是最新版本\n最后更新时间：${time}`)
      return true
    }

    await this.installDeps()
    await this.reply(`${pluginName}${branch ? `(${branch}分支)` : ''} 更新完成\n最后更新时间：${time}`)
    const log = await this.getLog()
    if (log) await this.reply(log)
    this.isUp = true
    return true
  }

  async installDeps() {
    await this.reply('更新拉取完成，正在执行 pnpm i 安装依赖，请稍等...')
    const ret = await this.exec(`cd ${pluginDir} && pnpm i`)
    if (ret.error) {
      logger.error(`[${pluginName}] 依赖安装失败：\n${ret.stderr || ret.error}`)
      await this.reply('依赖安装失败，请手动前往插件目录执行 pnpm i')
      return false
    }
    logger.mark(`[${pluginName}] 依赖安装成功`)
    return true
  }

  async restart() {
    const { Restart } = await import('../../other/restart.js')
    new Restart(this.e).restart()
  }

  async getLog() {
    if (!this.oldCommitId) return ''
    const raw = await this.execOutput(`cd ./plugins/${pluginName}/ && git log -20 --oneline --pretty=format:"%h||[%cd]  %s" --date=format:"%m-%d %H:%M"`).catch(() => '')
    if (!raw) return ''
    const lines = []
    for (const row of raw.split('\n')) {
      const [hash, text] = row.split('||')
      if (hash === this.oldCommitId) break
      if (!text || text.includes('Merge branch')) continue
      lines.push(text)
    }
    if (!lines.length) return ''
    return this.makeForwardMsg(
      `${pluginName} 更新日志，共 ${lines.length} 条`,
      lines.join('\n\n'),
      '更多详细信息，请前往 GitHub 查看\nhttps://github.com/AIGC-Yunzai/hapi_connector-plugin/commits/main\n\n更新后将自动重启云崽以生效',
    )
  }

  async makeForwardMsg(title, msg, end) {
    const bot = this.e.bot ?? Bot
    let nickname = bot.nickname || 'HAPI Connector'
    if (this.e.isGroup) {
      let info = null
      try {
        if (bot.getGroupMemberInfo) info = await bot.getGroupMemberInfo(this.e.group_id, bot.uin)
        else if (bot.pickMember) info = await bot.pickMember(this.e.group_id, bot.uin)
      } catch {}
      nickname = info?.card || info?.nickname || nickname
    }
    const userInfo = { user_id: bot.uin, nickname }
    const nodes = [
      { ...userInfo, message: title },
      { ...userInfo, message: msg },
    ]
    if (end) nodes.push({ ...userInfo, message: end })
    if (this.e.group?.makeForwardMsg) return this.e.group.makeForwardMsg(nodes)
    if (this.e.friend?.makeForwardMsg) return this.e.friend.makeForwardMsg(nodes)
    return [title, msg, end].filter(Boolean).join('\n\n')
  }

  async getCommitId() {
    return (await this.execOutput(`git -C ./plugins/${pluginName}/ rev-parse --short HEAD`)).trim()
  }

  async getTime() {
    return (await this.execOutput(`cd ./plugins/${pluginName}/ && git log -1 --oneline --pretty=format:"%cd" --date=format:"%m-%d %H:%M"`)).trim()
  }

  async exec(command) {
    return new Promise(resolve => {
      exec(command, { windowsHide: true }, (error, stdout, stderr) => resolve({ error, stdout, stderr }))
    })
  }

  async execOutput(command) {
    return execSync(command, { encoding: 'utf8' })
  }

  async checkGit() {
    try {
      const ret = execSync('git --version', { encoding: 'utf8' })
      if (ret.includes('git version')) return true
    } catch {}
    await this.reply('请先安装 git')
    return false
  }

  async gitErr(err, stdout = '') {
    const errMsg = String(err)
    if (/Timed out|Failed to connect|unable to access/i.test(errMsg)) {
      await this.reply(`更新失败，连接远端仓库异常：\n${errMsg}`)
      return
    }
    await this.reply([errMsg, String(stdout), '\n若存在 git 冲突，可尝试执行 #hapi强制更新'])
  }
}
