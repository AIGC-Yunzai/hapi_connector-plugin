import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  QQBOT_HELP,
  QQBOT_HELP_COMMAND_WIDTH,
  QQBOT_HELP_ITEMS,
  QQBOT_HELP_LINES,
} from '../utils/formatters.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const readme = fs.readFileSync(path.join(here, '..', 'README.md'), 'utf8').replace(/\r\n/g, '\n')

test('the qqbot command list has seven entries with unique, prefixed keys', () => {
  assert.equal(QQBOT_HELP_ITEMS.length, 7)

  const keys = QQBOT_HELP_ITEMS.map(item => item.key)
  assert.equal(new Set(keys).size, keys.length)
  // 锅巴帮助页的字段名是 help_<key>，裸 list/status 会撞上主指令条目
  for (const key of keys) assert.match(key, /^qqbot_/)
})

test('each entry carries a command and a title', () => {
  for (const item of QQBOT_HELP_ITEMS) {
    assert.match(item.command, /^#hapi qqbot \S/)
    assert.ok(item.title.trim().length > 0)
  }
})

test('help lines start every title at the same column', () => {
  assert.equal(QQBOT_HELP_LINES.length, QQBOT_HELP_ITEMS.length)

  QQBOT_HELP_LINES.forEach((line, index) => {
    const { command, title } = QQBOT_HELP_ITEMS[index]
    assert.equal(line.slice(0, QQBOT_HELP_COMMAND_WIDTH).trimEnd(), command)
    assert.equal(line.slice(QQBOT_HELP_COMMAND_WIDTH), title)
  })
})

test('the chat help text leads with a header and keeps every line', () => {
  const lines = QQBOT_HELP.split('\n')

  assert.equal(lines[0], 'QQ 官方机器人：')
  assert.deepEqual(lines.slice(1), QQBOT_HELP_LINES)
})

test('README carries the exact same block, so docs and help cannot drift', () => {
  assert.ok(readme.includes(QQBOT_HELP_LINES.join('\n')))
})
