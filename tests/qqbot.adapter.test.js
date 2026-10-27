import test from 'node:test'
import assert from 'node:assert/strict'

import { QQBotOfficialAdapter } from '../adapter/QQBotOfficial.js'
import { PassiveReplyTracker } from '../adapter/qqbot/passive.js'
import { RefIndex } from '../adapter/qqbot/refIndex.js'
import { InfoCache } from '../adapter/qqbot/infoCache.js'
import { QQBotApiError } from '../adapter/qqbot/api.js'

// 适配器与云崽其它模块一样用全局 logger，纯 node 环境补一个最小实现
globalThis.logger ||= { mark() {}, info() {}, warn() {}, error() {}, debug() {} }

/** 造一个只依赖 api 的 entry，绕开网关和网络 */
function makeEntry({ markdown = true, handler } = {}) {
  const sent = []
  const api = {
    async sendC2C(openid, payload) {
      sent.push({ scope: 'c2c', target: openid, payload })
      if (handler) return handler('c2c', payload, sent)
      return { id: `msg-${sent.length}`, timestamp: Date.now(), ext_info: { ref_idx: `REFIDX_out-${sent.length}` } }
    },
    async sendGroup(groupId, payload) {
      sent.push({ scope: 'group', target: groupId, payload })
      if (handler) return handler('group', payload, sent)
      return { id: `msg-${sent.length}`, timestamp: Date.now(), ext_info: { ref_idx: `REFIDX_out-${sent.length}` } }
    },
    async sendGuildChannel(channelId, payload) {
      sent.push({ scope: 'channel', target: channelId, payload })
      return { id: `msg-${sent.length}`, timestamp: Date.now() }
    },
    async uploadMedia(input) {
      sent.push({ scope: 'upload', input })
      return { fileInfo: 'FILE_INFO', fileUuid: 'uuid', ttl: 0 }
    },
    async request(method, path, opts) {
      sent.push({ scope: 'request', method, path, payload: opts?.json })
      return { id: `msg-${sent.length}`, timestamp: Date.now() }
    },
  }
  const entry = {
    appid: '102030405',
    account: { appid: '102030405', markdown },
    api,
    tracker: new PassiveReplyTracker(),
    refIndex: new RefIndex(),
    infoCache: new InfoCache(),
    dedup: new Map(),
    dmTargets: new Map(),
    ready: true,
    gateway: { connected: true, sessionId: 's' },
  }
  return { entry, sent }
}

const adapter = new QQBotOfficialAdapter()

test('普通文本默认以 markdown 发送，主动发送不带 msg_id', async () => {
  const { entry, sent } = makeEntry()
  await adapter.sendTo(entry, { scope: 'c2c', id: 'U1' }, '你好')

  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].payload, { markdown: { content: '你好' }, msg_type: 2 })
})

test('收到入站消息后自动挂 msg_id 与自增 msg_seq，普通回复不自动引用', async () => {
  const { entry, sent } = makeEntry()
  const chat = { scope: 'group', id: 'G1' }
  entry.tracker.remember(chat, { messageId: 'IN-1', refIdx: 'REFIDX_1' })

  await adapter.sendTo(entry, chat, '第一条')
  await adapter.sendTo(entry, chat, '第二条')

  assert.equal(sent[0].payload.msg_id, 'IN-1')
  assert.equal(sent[0].payload.msg_seq, 1)
  assert.equal(sent[1].payload.msg_seq, 2)
  // 自动引用会把用户的触发消息再渲染一遍，官方 bot 显示在气泡里就像重复发送
  assert.equal(sent[0].payload.message_reference, undefined)
})

test('一条消息带两个媒体时拆成两次请求，且都带图注', async () => {
  const { entry, sent } = makeEntry()
  await adapter.sendTo(entry, { scope: 'group', id: 'G1' }, [
    { type: 'text', text: '图一' },
    { type: 'image', file: 'https://x/1.png' },
    { type: 'text', text: '图二' },
    { type: 'image', file: 'https://x/2.png' },
  ])

  const sends = sent.filter(item => item.scope !== 'upload')
  assert.equal(sends.length, 2)
  assert.equal(sends[0].payload.msg_type, 7)
  assert.equal(sends[0].payload.content, '图一图二')
  assert.equal(sends[0].payload.markdown, undefined, '富媒体必须移除 markdown')
  assert.deepEqual(sends[0].payload.media, { file_info: 'FILE_INFO' })
})

test('markdown 被平台拒绝时自动降级为纯文本重发', async () => {
  const { entry, sent } = makeEntry({
    handler: (scope, payload) => {
      if (payload.markdown) throw new QQBotApiError('QQ 接口错误 [400] /x: 不允许发送原生 markdown', { status: 400 })
      return { id: 'ok' }
    },
  })
  const result = await adapter.sendTo(entry, { scope: 'c2c', id: 'U1' }, '**加粗**')

  assert.equal(result.id, 'ok')
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[1].payload, { content: '**加粗**', msg_type: 0 })
})

test('被动回复失败时先改主动发送，不立刻降级 markdown', async () => {
  const { entry, sent } = makeEntry({
    handler: (scope, payload) => {
      if (payload.msg_id) throw new QQBotApiError('QQ 接口错误 [400] /x: msg_id 无效', { status: 400 })
      return { id: 'ok' }
    },
  })
  const chat = { scope: 'c2c', id: 'U1' }
  entry.tracker.remember(chat, { messageId: 'IN-9' })

  const result = await adapter.sendTo(entry, chat, 'hi')
  assert.equal(result.id, 'ok')
  assert.equal(sent.length, 2)
  assert.equal(sent[0].payload.msg_id, 'IN-9')
  assert.equal(sent[1].payload.msg_id, undefined)
  assert.equal(sent[1].payload.msg_seq, undefined)
  assert.deepEqual(sent[1].payload.markdown, { content: 'hi' }, '第二次仍是 markdown')
})

test('5xx 与超时可能已送达，不再重发，避免同一条消息出现两次', async () => {
  const { entry, sent } = makeEntry({
    handler: () => {
      throw new QQBotApiError('QQ 接口错误 [500] /x: internal error', { status: 500 })
    },
  })
  const chat = { scope: 'c2c', id: 'U1' }
  entry.tracker.remember(chat, { messageId: 'IN-9' })

  await assert.rejects(() => adapter.sendTo(entry, chat, 'hi'), /500/)
  assert.equal(sent.length, 1, '只尝试一次，不能改成主动发送再发一遍')
})

test('权限类错误不吞掉，直接抛给调用方', async () => {
  const { entry } = makeEntry({
    handler: () => {
      throw new QQBotApiError('QQ 接口错误 [403] /x: forbidden', { status: 403 })
    },
  })
  await assert.rejects(() => adapter.sendTo(entry, { scope: 'c2c', id: 'U1' }, 'hi'), /forbidden/)
})

test('关闭 markdown 后纯文本走 content，但显式 markdown 段仍然走 markdown', async () => {
  const { entry, sent } = makeEntry({ markdown: false })
  const chat = { scope: 'group', id: 'G1' }

  await adapter.sendTo(entry, chat, '普通文本')
  await adapter.sendTo(entry, chat, [{ type: 'markdown', content: '# 标题' }])

  assert.equal(sent[0].payload.msg_type, 0)
  assert.equal(sent[0].payload.content, '普通文本')
  assert.equal(sent[1].payload.msg_type, 2)
  assert.deepEqual(sent[1].payload.markdown, { content: '# 标题' })
})

test('好友与群都用 openid 作目标，路径参数正确', async () => {
  const { entry, sent } = makeEntry()
  await adapter.sendTo(entry, { scope: 'c2c', id: 'OPENID_A' }, 'a')
  await adapter.sendTo(entry, { scope: 'group', id: 'GROUP_A' }, 'b')
  assert.equal(sent[0].target, 'OPENID_A')
  assert.equal(sent[1].target, 'GROUP_A')
})

/** 装上最小的 Bot 全局，只保留事件派发与日志 */
function stubBot() {
  const emitted = []
  globalThis.Bot = {
    adapter: [],
    uin: [],
    makeLog: () => {},
    em: (name, data) => emitted.push({ name, data }),
    once: () => {},
  }
  return emitted
}

test('群消息被规范化成 message.group.normal 并剥掉 @ 标记', async () => {
  const emitted = stubBot()
  const { entry } = makeEntry()
  entry.bot = { info: { user_id: '102030405' } }

  await adapter.dispatch(entry, 'GROUP_AT_MESSAGE_CREATE', {
    id: 'ROBOT1.0_abc',
    group_openid: 'G-OPENID',
    content: '<qqbot-at-user id="102030405" /> 帮我看看',
    timestamp: '1700000000',
    author: { member_openid: 'M-1', username: '张三' },
    message_scene: { ext: ['msg_idx=REFIDX_ref'] },
    attachments: [],
  })

  assert.equal(emitted.length, 1)
  const { name, data } = emitted[0]
  assert.equal(name, 'message.group.normal')
  assert.equal(data.self_id, '102030405')
  assert.equal(data.group_id, 'G-OPENID')
  assert.equal(data.user_id, 'M-1')
  assert.equal(data.isGroup, true)
  assert.equal(data.raw_message, '帮我看看')
  // 群 @ 事件要带 at 段，云崽才会置 e.atBot（onlyReplyAt=1 的群靠这个）
  assert.deepEqual(data.message[0], { type: 'at', qq: '102030405' })
  assert.deepEqual(data.message[1], { type: 'text', text: '帮我看看' })
  assert.equal(data.time, 1700000000)
  assert.equal(data.bot, entry.bot)
})

test('派发时不预置 msg，云崽拼接 text 段后指令文本不会翻倍', async () => {
  const emitted = stubBot()
  const { entry } = makeEntry()
  entry.bot = {}

  await adapter.dispatch(entry, 'GROUP_AT_MESSAGE_CREATE', {
    id: 'ROBOT1.0_dup',
    group_openid: 'G-1',
    content: '#设置主人',
    author: { member_openid: 'M-1' },
    attachments: [],
  })

  const { data } = emitted[0]
  assert.equal(data.msg, undefined, '预置 msg 会被 dealEvent 再拼一次，指令就再也匹配不上')
  // 复刻云崽 loader.dealEvent：e.msg = (e.msg || "") + 各 text 段
  const built = (data.msg || '') + data.message.filter(i => i.type === 'text').map(i => i.text).join('')
  assert.equal(built, '#设置主人')
})

test('私聊消息派发成 message.private.normal，用户 id 取 user_openid', async () => {
  const emitted = stubBot()
  const { entry } = makeEntry()
  entry.bot = {}

  await adapter.dispatch(entry, 'C2C_MESSAGE_CREATE', {
    id: 'ROBOT1.0_c2c',
    content: '在吗',
    author: { user_openid: 'U-OPENID', username: '李四' },
    attachments: [],
  })

  assert.equal(emitted[0].name, 'message.private.normal')
  assert.equal(emitted[0].data.user_id, 'U-OPENID')
  assert.equal(emitted[0].data.isPrivate, true)
})

test('同一个 message_id 只派发一次（Resume 会重复投递）', async () => {
  const emitted = stubBot()
  const { entry } = makeEntry()
  entry.bot = {}
  const payload = { id: 'DUP-1', group_openid: 'G', content: 'x', author: { member_openid: 'M' }, attachments: [] }

  await adapter.dispatch(entry, 'GROUP_AT_MESSAGE_CREATE', payload)
  await adapter.dispatch(entry, 'GROUP_AT_MESSAGE_CREATE', payload)

  assert.equal(emitted.length, 1)
})

test('未订阅的事件类型被忽略，不抛错', async () => {
  const emitted = stubBot()
  const { entry } = makeEntry()
  entry.bot = {}

  await adapter.dispatch(entry, 'MESSAGE_REACTION_ADD', { id: 'x' })
  await adapter.dispatch(entry, 'INTERACTION_CREATE', { id: 'y' })

  assert.equal(emitted.length, 0)
})

test('入站后同会话发送带上该消息的 msg_id，普通回复不再自动引用', async () => {
  const emitted = stubBot()
  const { entry, sent } = makeEntry()
  entry.bot = {}

  await adapter.dispatch(entry, 'GROUP_AT_MESSAGE_CREATE', {
    id: 'IN-42',
    group_openid: 'G-1',
    content: 'hi',
    author: { member_openid: 'M' },
    message_scene: { ext: ['msg_idx=REFIDX_42'] },
    attachments: [],
  })
  await adapter.sendTo(entry, { scope: 'group', id: 'G-1' }, '收到')

  assert.equal(emitted.length, 1)
  assert.equal(sent[0].payload.msg_id, 'IN-42')
  assert.equal(sent[0].payload.msg_seq, 1)
  // 没有显式引用就不带 message_reference，否则官方 bot 会把触发消息一起显示
  assert.equal(sent[0].payload.message_reference, undefined)
})

test('e.reply(msg, true) 带上的本条消息 id 会换算成 REFIDX 并引用', async () => {
  const { entry, sent } = makeEntry()
  const chat = { scope: 'group', id: 'G-1' }
  entry.tracker.remember(chat, { messageId: 'IN-42', refIdx: 'REFIDX_42' })

  // 云崽的 loader.reply 在 quote=true 时会 unshift 一个 reply 段，id 就是本条入站消息
  await adapter.sendTo(entry, chat, [
    { type: 'reply', id: 'IN-42' },
    { type: 'text', text: '收到' },
  ])

  assert.deepEqual(sent[0].payload.message_reference, { message_id: 'REFIDX_42' })
})

test('两个群各自持有 msg_id，不会串用', async () => {
  stubBot()
  const { entry, sent } = makeEntry()
  entry.bot = {}

  for (const [group, id] of [
    ['G-1', 'IN-G1'],
    ['G-2', 'IN-G2'],
  ]) {
    await adapter.dispatch(entry, 'GROUP_AT_MESSAGE_CREATE', {
      id,
      group_openid: group,
      content: 'hi',
      author: { member_openid: 'M' },
      attachments: [],
    })
  }

  await adapter.sendTo(entry, { scope: 'group', id: 'G-1' }, '回一群')
  await adapter.sendTo(entry, { scope: 'group', id: 'G-2' }, '回二群')

  assert.equal(sent[0].payload.msg_id, 'IN-G1')
  assert.equal(sent[1].payload.msg_id, 'IN-G2')
})

test('频道事件用 guild-channel 作 group_id，发送时不带 msg_type', async () => {
  const emitted = stubBot()
  const { entry, sent } = makeEntry()
  entry.bot = {}

  await adapter.dispatch(entry, 'AT_MESSAGE_CREATE', {
    id: 'IN-CH',
    channel_id: 'C-1',
    guild_id: 'GU-1',
    content: 'hi',
    author: { id: 'U-1', username: '频道用户' },
    attachments: [],
  })

  assert.equal(emitted[0].name, 'message.group.guild')
  assert.equal(emitted[0].data.group_id, 'GU-1-C-1')
  assert.equal(emitted[0].data.channel_id, 'C-1')

  await adapter.sendTo(entry, { scope: 'channel', id: 'C-1', guildId: 'GU-1' }, '回频道')
  const channelSend = sent.find(item => item.scope === 'channel')
  assert.equal(channelSend.payload.msg_type, undefined, '频道接口不接受 msg_type')
  assert.equal(channelSend.payload.markdown !== undefined || channelSend.payload.content !== undefined, true)
})

/** 内存版账号表，只实现 updateAccount 用到的两个方法 */
function makeStore(seed = {}) {
  const accounts = new Map(Object.entries(seed))
  return {
    accounts,
    get: id => accounts.get(String(id)) || null,
    upsert(input) {
      const account = { ...input }
      accounts.set(String(account.appid), account)
      return account
    },
    list: () => [...accounts.values()],
    remove: id => accounts.delete(String(id)),
  }
}

test('updateAccount 换掉 entry.account，发送时读到新的 markdown 开关', async () => {
  const instance = new QQBotOfficialAdapter({
    store: makeStore({ 102030405: { appid: '102030405', secret: 's', markdown: true } }),
  })
  const { entry, sent } = makeEntry({ markdown: true })
  instance.entries.set('102030405', entry)

  instance.updateAccount('102030405', { markdown: false })
  await instance.sendTo(entry, { scope: 'c2c', id: 'U1' }, '纯文本')

  assert.equal(entry.account.markdown, false, 'entry.account 必须换成新对象')
  assert.equal(sent[0].payload.msg_type, 0)
  assert.equal(sent[0].payload.content, '纯文本')
})

test('updateAccount 对未知 AppID 抛错，不清空既有配置', () => {
  const store = makeStore({ 102030405: { appid: '102030405', secret: 's', markdown: true } })
  const instance = new QQBotOfficialAdapter({ store })

  assert.throws(() => instance.updateAccount('999', { markdown: false }), /未找到/)
  assert.equal(store.get('102030405').markdown, true)
})

test('频道私信入站记住 user→guild 映射，回消息走 /dms 而不是 c2c', async () => {
  const emitted = stubBot()
  const { entry, sent } = makeEntry()
  entry.bot = {}

  await adapter.dispatch(entry, 'DIRECT_MESSAGE_CREATE', {
    id: 'IN-DM',
    guild_id: 'GU-DM',
    channel_id: 'C-DM',
    content: '私信',
    author: { id: 'U-DM', username: '私信用户' },
    attachments: [],
  })

  assert.equal(emitted[0].name, 'message.private.normal')
  assert.equal(emitted[0].data.group_id, undefined, '私信不该带 group_id')
  assert.equal(entry.dmTargets.get('U-DM'), 'GU-DM')

  assert.deepEqual(adapter.resolveFriendChat(entry, 'U-DM'), {
    scope: 'dm',
    id: 'GU-DM',
    guildId: 'GU-DM',
  })
  assert.deepEqual(adapter.resolveFriendChat(entry, 'U-陌生'), { scope: 'c2c', id: 'U-陌生' })

  await adapter.sendTo(entry, { scope: 'dm', id: 'GU-DM', guildId: 'GU-DM' }, '回私信')
  const dm = sent.find(item => item.scope === 'request')
  assert.equal(dm.path, '/dms/GU-DM/messages')
  assert.equal(dm.payload.msg_type, undefined, '私信接口不接受 msg_type')
  assert.equal(dm.payload.msg_id, 'IN-DM', '私信仍可被动回复')
  assert.equal(dm.payload.msg_seq, 1)
})

test('频道图片走 file_image 内联，不经过 v2 上传', async () => {
  const { entry, sent } = makeEntry()
  await adapter.sendTo(entry, { scope: 'channel', id: 'C-1', guildId: 'GU-1' }, [
    { type: 'text', text: '看图' },
    { type: 'image', file: 'base64://QUJD' },
  ])

  assert.equal(sent.some(item => item.scope === 'upload'), false, '频道不走上传接口')
  const channel = sent.find(item => item.scope === 'channel')
  assert.equal(channel.payload.file_image, 'QUJD')
  assert.equal(channel.payload.content, '看图')
  assert.equal(channel.payload.media, undefined)
  assert.equal(channel.payload.msg_type, undefined)
})

test('频道发视频直接报错，不静默丢消息', async () => {
  const { entry } = makeEntry()
  await assert.rejects(
    () =>
      adapter.sendTo(entry, { scope: 'channel', id: 'C-1', guildId: 'GU-1' }, {
        type: 'video',
        file: 'https://example.com/a.mp4',
      }),
    /只能发图片/,
  )
})

test('引用机器人自己发过的消息：用发出时的 id 就能引用到', async () => {
  const { entry, sent } = makeEntry()
  const chat = { scope: 'c2c', id: 'U1' }

  const first = await adapter.sendTo(entry, chat, '第一张图')
  assert.equal(first.refIdx, 'REFIDX_out-1')

  await adapter.sendTo(entry, chat, [
    { type: 'reply', id: first.message_id },
    { type: 'text', text: '就是上面这条' },
  ])

  assert.deepEqual(sent[1].payload.message_reference, { message_id: 'REFIDX_out-1' })
})

test('引用未知的 ROBOT1.0 id 时按 ADR-0004 回退到本条被动消息', async () => {
  const { entry, sent } = makeEntry()
  const chat = { scope: 'group', id: 'G1' }
  entry.tracker.remember(chat, { messageId: 'IN-1', refIdx: 'REFIDX_self' })

  await adapter.sendTo(entry, chat, [
    { type: 'reply', id: 'ROBOT1.0_unknown' },
    { type: 'text', text: '回一句' },
  ])

  assert.deepEqual(sent[0].payload.message_reference, { message_id: 'REFIDX_self' })
})

test('发送响应没有 ext_info 时不入索引，也不影响发送', async () => {
  // 频道与频道私信就是这样：响应里没有 ext_info
  const { entry, sent } = makeEntry({ handler: () => ({ id: 'msg-no-ref', timestamp: 0 }) })
  const chat = { scope: 'group', id: 'G1' }

  const result = await adapter.sendTo(entry, chat, '纯文本')
  assert.equal(result.refIdx, '')
  assert.equal(entry.refIndex.size, 0)

  await adapter.sendTo(entry, chat, [
    { type: 'reply', id: result.message_id },
    { type: 'text', text: '再一句' },
  ])
  // 索引里没有，也没有被动窗口，于是不带引用
  assert.equal(sent[1].payload.message_reference, undefined)
})

test('频道用消息 id 直接引用，不要求 REFIDX 形态', async () => {
  const { entry, sent } = makeEntry()
  await adapter.sendTo(entry, { scope: 'channel', id: 'C-1', guildId: 'GU-1' }, [
    { type: 'reply', id: 'CH-MSG-1' },
    { type: 'text', text: '回频道那条' },
  ])

  const channel = sent.find(item => item.scope === 'channel')
  assert.deepEqual(channel.payload.message_reference, { message_id: 'CH-MSG-1' })
})

test('频道里没给引用目标时不硬塞 message_reference', async () => {
  const { entry, sent } = makeEntry()
  await adapter.sendTo(entry, { scope: 'channel', id: 'C-1', guildId: 'GU-1' }, '普通消息')

  const channel = sent.find(item => item.scope === 'channel')
  assert.equal(channel.payload.message_reference, undefined)
})

test('频道 @ 消息剥掉 <@!id>，补 at 段，time 不再是 NaN', async () => {
  const emitted = stubBot()
  const { entry } = makeEntry()
  entry.bot = {}

  await adapter.dispatch(entry, 'AT_MESSAGE_CREATE', {
    id: 'IN-CH-2',
    channel_id: 'C-9',
    guild_id: 'GU-9',
    content: '<@!BOT-GUILD> #hapi status',
    timestamp: '2026-10-28T02:20:00+08:00',
    mentions: [{ id: 'BOT-GUILD', username: '云崽' }],
    author: { id: 'U-9', username: '频道用户' },
    attachments: [],
  })

  const { data } = emitted[0]
  assert.deepEqual(data.message[0], { type: 'at', qq: '102030405' })
  assert.equal(data.raw_message, '#hapi status')
  assert.equal(data.time, Math.floor(Date.parse('2026-10-28T02:20:00+08:00') / 1000))
})

test('群名缺失时查一次 /info，写进 e.group_name 后走缓存', async () => {
  const emitted = stubBot()
  const { entry } = makeEntry()
  entry.bot = {}
  const calls = []
  entry.api.getGroupInfo = async id => {
    calls.push(id)
    return { group_name: '测试群', group_member_num: 42 }
  }

  const payload = { group_openid: 'G-NAME', content: 'hi', author: { member_openid: 'M' }, attachments: [] }
  await adapter.dispatch(entry, 'GROUP_AT_MESSAGE_CREATE', { ...payload, id: 'IN-GN-1' })
  await adapter.dispatch(entry, 'GROUP_AT_MESSAGE_CREATE', { ...payload, id: 'IN-GN-2' })

  assert.equal(calls.length, 1, '同一个群只查一次')
  assert.equal(emitted[0].data.group_name, '测试群')
  assert.equal(emitted[1].data.group_name, '测试群')
  assert.equal(emitted[0].data.group_name, emitted[1].data.group_name)
})

test('群信息接口失败不影响消息派发', async () => {
  const emitted = stubBot()
  const { entry } = makeEntry()
  entry.bot = {}
  entry.api.getGroupInfo = async () => {
    throw new Error('boom')
  }

  await adapter.dispatch(entry, 'GROUP_AT_MESSAGE_CREATE', {
    id: 'IN-GFAIL',
    group_openid: 'G-FAIL',
    content: 'hi',
    author: { member_openid: 'M' },
    attachments: [],
  })

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].data.group_name, undefined)
})

test('C2C 流式：state=1 追加，state=10 自动补换行并沿用 streamId', async () => {
  const { entry, sent } = makeEntry()
  const chat = { scope: 'c2c', id: 'U1' }

  const first = await adapter.sendStream(entry, chat, { text: '你', state: 1, index: 0 })
  assert.deepEqual(sent[0].payload.stream, { state: 1, index: 0, reset: false })
  assert.equal(sent[0].payload.msg_type, 2)
  assert.equal(first.streamId, 'msg-1')

  await adapter.sendStream(entry, chat, { text: '好', state: 10, index: 1, streamId: first.streamId })
  assert.equal(sent[1].payload.stream.id, 'msg-1')
  assert.equal(sent[1].payload.stream.state, 10)
  assert.equal(sent[1].payload.markdown.content, '好\n')
})

test('流式只支持私聊，群聊直接抛错', async () => {
  const { entry } = makeEntry()
  await assert.rejects(
    () => adapter.sendStream(entry, { scope: 'group', id: 'G1' }, { text: 'x' }),
    /只支持私聊/,
  )
})

test('流式第一帧自动取被动凭据，后续帧复用同一对 msg_id/msg_seq', async () => {
  const { entry, sent } = makeEntry()
  const chat = { scope: 'c2c', id: 'U1' }
  entry.tracker.remember(chat, { messageId: 'IN-STREAM', refIdx: 'REFIDX_STREAM' })

  const first = await adapter.sendStream(entry, chat, { text: '你', state: 1, index: 0 })
  assert.equal(sent[0].payload.msg_id, 'IN-STREAM')
  assert.equal(sent[0].payload.msg_seq, 1)
  assert.equal(first.messageId, 'IN-STREAM')
  assert.equal(first.msgSeq, 1)

  await adapter.sendStream(entry, chat, {
    text: '好',
    state: 10,
    index: 1,
    streamId: first.streamId,
    messageId: first.messageId,
    msgSeq: first.msgSeq,
  })
  assert.equal(sent[1].payload.msg_id, 'IN-STREAM')
  assert.equal(sent[1].payload.msg_seq, 1, '后续帧沿用第一帧的序号，不重复消耗预算')
  assert.equal(sent[1].payload.stream.id, first.streamId)
})
