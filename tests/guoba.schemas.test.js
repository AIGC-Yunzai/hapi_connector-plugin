import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { QQBOT_HELP_ITEMS } from '../utils/formatters.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.resolve(here, '..')

/**
 * `guoba.support.js` 只能整模块导入，而它顶层 import 的 Config 在加载时就
 * `new Config()`：会照 cwd 下的 `plugins/<name>/config` 建目录、拷默认配置，
 * 并 `fs.watch` 一份配置（watch 句柄会让测试进程不退出）。
 *
 * 所以先把 cwd 换到一个临时根目录、在那儿摆好默认配置，再把 fs.watch 换成空实现。
 * 这样既不碰工作区，也不会挂住进程。
 */
async function loadGuoba() {
  globalThis.logger ||= { mark() {}, info() {}, warn() {}, error() {}, debug() {} }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hapi-guoba-'))
  const tmpPlugin = path.join(tmpRoot, 'plugins', 'hapi_connector-plugin')
  fs.mkdirSync(path.join(tmpPlugin, 'config'), { recursive: true })
  fs.copyFileSync(
    path.join(pluginDir, 'config', 'hapi_default.yaml'),
    path.join(tmpPlugin, 'config', 'hapi_default.yaml'),
  )

  const cwd = process.cwd()
  const realWatch = fs.watch
  fs.watch = () => ({ close() {}, on() {} })
  process.chdir(tmpRoot)
  try {
    const mod = await import(pathToFileURL(path.join(pluginDir, 'guoba.support.js')).href)
    return mod.supportGuoba()
  } finally {
    process.chdir(cwd)
    fs.watch = realWatch
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

const guoba = await loadGuoba()
const { schemas } = guoba.configInfo

test('every schema field is unique, so two panels never fight over one key', () => {
  const fields = schemas.filter(schema => schema.field).map(schema => schema.field)

  assert.ok(fields.length > 50)
  assert.deepEqual(fields.filter((field, index) => fields.indexOf(field) !== index), [])
})

test('the robot card exposes the markdown switch next to the enable switch', () => {
  const card = schemas.find(schema => schema.component === 'GSubForm')
  const fields = card.componentProps.schemas.map(schema => schema.field)

  assert.deepEqual(fields, ['appid', 'remark', 'status', 'markdown', 'enabled'])

  const markdown = card.componentProps.schemas.find(schema => schema.field === 'markdown')
  assert.equal(markdown.component, 'Switch')
  assert.match(markdown.bottomHelpMessage, /segment\.markdown/)
})

test('the help tab carries every #hapi qqbot command as a read-only field', () => {
  const helpFields = new Map(
    schemas.filter(schema => schema.field?.startsWith('help_qqbot_')).map(schema => [schema.field, schema]),
  )

  assert.equal(helpFields.size, QQBOT_HELP_ITEMS.length)
  for (const item of QQBOT_HELP_ITEMS) {
    const schema = helpFields.get(`help_${item.key}`)
    assert.ok(schema, `缺少帮助条目 help_${item.key}`)
    assert.equal(schema.component, 'Input')
    assert.equal(schema.componentProps.readonly, true)
    assert.equal(schema.componentProps.defaultValue, item.command)
    assert.equal(schema.label, item.title)
  }
})

test('the help tab marks the qqbot group apart from the hapi groups', () => {
  const index = schemas.findIndex(schema => schema.component === 'Divider' && schema.label === 'QQ 官方机器人')

  assert.ok(index > 0)
  // 分组标题之后紧跟的应该就是 qqbot 指令，中间不夹别的条目
  assert.match(schemas[index + 1].field, /^help_qqbot_/)
})
