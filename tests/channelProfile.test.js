import assert from 'node:assert/strict'
import test from 'node:test'
import {
  QQBOT_ADAPTER_ID,
  globalProfile,
  parseWindowKey,
  resolveChannelProfile,
  splitsSummary,
} from '../utils/channelProfile.js'

const CONFIG = {
  output_level: 'detail',
  markdown_output: 'image',
  qqbot_output_level: 'summary',
  qqbot_markdown_output: 'both',
  qqbot_summary_markdown: true,
}

const BOTS = {
  10001: { adapter: { id: QQBOT_ADAPTER_ID } },
  20002: { adapter: { id: 'OneBotv11' } },
}
const lookup = uin => BOTS[uin]

test('parseWindowKey reads the bot uin, not the adapter prefix', () => {
  assert.deepEqual(parseWindowKey('onebot:10001:private:abc123'), {
    selfId: '10001',
    scene: 'private',
    target: 'abc123',
  })
  // 频道群号是 guild-channel，本身带连字符；target 一律原样返回
  assert.deepEqual(parseWindowKey('onebot:10001:group:123456-654321'), {
    selfId: '10001',
    scene: 'group',
    target: '123456-654321',
  })
  // openid 里带冒号也不能被截断
  assert.equal(parseWindowKey('onebot:10001:private:a:b:c').target, 'a:b:c')
  for (const bad of ['', 'onebot:10001', null, undefined]) assert.equal(parseWindowKey(bad), null)
})

test('an official bot window gets its own push settings', () => {
  const profile = resolveChannelProfile('onebot:10001:group:123456', CONFIG, lookup)
  assert.deepEqual(profile, {
    isOfficial: true,
    outputLevel: 'summary',
    markdownOutput: 'both',
    summaryMarkdown: true,
  })
  assert.equal(splitsSummary(profile), true)
})

test('inherit follows the global push level', () => {
  const profile = resolveChannelProfile('onebot:10001:private:abc', { ...CONFIG, qqbot_output_level: 'inherit' }, lookup)
  assert.equal(profile.outputLevel, 'detail')
  assert.equal(profile.isOfficial, true)
})

test('unknown or malformed values fall back instead of breaking output', () => {
  const profile = resolveChannelProfile('onebot:10001:private:abc', {
    ...CONFIG,
    qqbot_output_level: 'loud',
    qqbot_markdown_output: 'video',
  }, lookup)
  assert.equal(profile.outputLevel, 'detail')
  assert.equal(profile.markdownOutput, 'text')
})

test('the summary switch can be turned off', () => {
  const profile = resolveChannelProfile('onebot:10001:private:abc', { ...CONFIG, qqbot_summary_markdown: false }, lookup)
  assert.equal(profile.summaryMarkdown, false)
  assert.equal(splitsSummary(profile), false)
})

test('other adapters keep the global settings', () => {
  for (const key of ['onebot:20002:group:123456', 'onebot:99999:private:abc', 'not-a-window']) {
    assert.deepEqual(resolveChannelProfile(key, CONFIG, lookup), globalProfile(CONFIG))
  }
})

test('globalProfile normalises missing or invalid config', () => {
  assert.deepEqual(globalProfile({}), {
    isOfficial: false,
    outputLevel: 'simple',
    markdownOutput: 'text',
    summaryMarkdown: false,
  })
  assert.deepEqual(globalProfile({ output_level: 'silence', markdown_output: 'both' }), {
    isOfficial: false,
    outputLevel: 'silence',
    markdownOutput: 'both',
    summaryMarkdown: false,
  })
})
