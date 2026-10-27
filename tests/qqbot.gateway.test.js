import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { QQBotGateway } from '../adapter/qqbot/gateway.js'
import { OP } from '../adapter/qqbot/constants.js'

// 网关用全局 logger，纯 node 环境补一个最小实现
const warnings = []
globalThis.logger ||= {
  mark() {},
  info() {},
  warn: msg => warnings.push(String(msg)),
  error() {},
  debug() {},
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate, timeout = 1_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    if (predicate()) return true
    await delay(5)
  }
  return false
}

/** 假的 WebSocket：只实现网关用到的几个成员，open 在下一个微任务里触发 */
class FakeSocket extends EventEmitter {
  static instances = []

  constructor(url, opts) {
    super()
    this.url = url
    this.opts = opts
    this.readyState = 0
    this.sent = []
    this.closeCalls = []
    this.terminated = false
    FakeSocket.instances.push(this)
    queueMicrotask(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.emit('open')
    })
  }

  static reset() {
    FakeSocket.instances = []
    warnings.length = 0
  }

  send(text) {
    this.sent.push(JSON.parse(text))
  }

  close(code, reason) {
    this.closeCalls.push({ code, reason })
    if (this.readyState === 3) return
    this.readyState = 3
    queueMicrotask(() => this.emit('close', code ?? 1005, reason ?? ''))
  }

  terminate() {
    this.terminated = true
    if (this.readyState === 3) return
    this.readyState = 3
    queueMicrotask(() => this.emit('close', 1006, ''))
  }

  /** 服务端下发一帧 */
  push(payload) {
    this.emit('message', Buffer.from(JSON.stringify(payload)))
  }
}

/** 永远不 open 的 socket，用来验证建连超时 */
class SilentSocket extends EventEmitter {
  constructor(url, opts) {
    super()
    this.url = url
    this.opts = opts
    this.readyState = 0
    this.sent = []
    this.closeCalls = []
    this.terminated = false
    FakeSocket.instances.push(this)
  }

  send() {}

  close(code, reason) {
    this.closeCalls.push({ code, reason })
    if (this.readyState === 3) return
    this.readyState = 3
    queueMicrotask(() => this.emit('close', code ?? 1005, reason ?? ''))
  }

  terminate() {
    this.terminated = true
    if (this.readyState === 3) return
    this.readyState = 3
    queueMicrotask(() => this.emit('close', 1006, ''))
  }
}

/** close 事件迟到的 socket：用来验证旧连接不会踩掉新连接 */
class SlowCloseSocket extends SilentSocket {
  terminate() {
    this.terminated = true
    if (this.readyState === 3) return
    this.readyState = 3
    setTimeout(() => this.emit('close', 1006, ''), 80)
  }
}

function makeApi() {
  return {
    token: 'TOKEN',
    invalidateToken() {},
    async getGatewayUrl() {
      return 'wss://gateway.test'
    },
    async getAccessToken() {
      return 'TOKEN'
    },
  }
}

function makeGateway(options = {}) {
  return new QQBotGateway({
    api: makeApi(),
    intents: 1,
    ua: 'test-agent',
    backoff: [10],
    wsImpl: { Ctor: FakeSocket, native: false },
    ...options,
  })
}

/** 把一条连接推进到 READY */
async function readied(gateway, socket) {
  const ready = new Promise(resolve => gateway.once('ready', resolve))
  socket.push({ op: OP.HELLO, d: { heartbeat_interval: 45_000 } })
  socket.push({ op: OP.DISPATCH, s: 1, t: 'READY', d: { session_id: 'SESSION' } })
  await ready
}

test('连接建立后不会被建连看门狗掐断，20 秒超时只作用于建连阶段', async () => {
  FakeSocket.reset()
  const gateway = makeGateway({ connectTimeoutMs: 40, handshakeTimeoutMs: 5_000 })
  const running = gateway.start()
  try {
    assert.ok(await waitFor(() => FakeSocket.instances.length === 1), '应该发起连接')
    const socket = FakeSocket.instances[0]
    await readied(gateway, socket)

    // 超过建连超时好几倍，连接必须仍然在
    await delay(200)

    assert.equal(socket.terminated, false, '连接成功后建连看门狗不能再触发')
    assert.equal(socket.closeCalls.length, 0, '连接成功后不该主动关闭')
    assert.equal(gateway.connected, true)
    assert.equal(gateway.sessionId, 'SESSION')
  } finally {
    await gateway.stop()
    await running
  }
})

test('open 之后迟迟收不到 HELLO/READY 时按握手超时重连', async () => {
  FakeSocket.reset()
  const gateway = makeGateway({ connectTimeoutMs: 5_000, handshakeTimeoutMs: 40 })
  const running = gateway.start()
  try {
    assert.ok(await waitFor(() => FakeSocket.instances.length === 1))
    const socket = FakeSocket.instances[0]
    assert.ok(await waitFor(() => socket.closeCalls.length > 0 || socket.terminated), '应该判定握手超时')
    assert.equal(socket.closeCalls[0]?.reason, 'handshake timeout')
  } finally {
    await gateway.stop()
    await running
  }
})

test('真正连不上时仍按建连超时判失败（错误码保持 timeout）', async () => {
  FakeSocket.reset()
  const gateway = new QQBotGateway({
    api: makeApi(),
    intents: 1,
    ua: 'test-agent',
    connectTimeoutMs: 30,
    maxAttempts: 1,
    backoff: [10],
    wsImpl: { Ctor: SilentSocket, native: false },
  })

  const offline = []
  const fatal = []
  gateway.on('offline', (code, reason) => offline.push(`${code} ${reason}`))
  gateway.on('fatal', (code, reason) => fatal.push(`${code} ${reason}`))

  await gateway.start()

  assert.equal(offline.length, 1)
  assert.match(offline[0], /^timeout 连接网关超时$/)
  assert.equal(fatal.length, 1, 'maxAttempts=1 时重试耗尽')
  assert.equal(FakeSocket.instances.at(-1).terminated, true)
})

test('心跳没有回执时判定连接假死并重连', async () => {
  FakeSocket.reset()
  const gateway = makeGateway({ minHeartbeatMs: 20, connectTimeoutMs: 5_000, handshakeTimeoutMs: 5_000 })
  const running = gateway.start()
  try {
    assert.ok(await waitFor(() => FakeSocket.instances.length === 1))
    const socket = FakeSocket.instances[0]
    const ready = new Promise(resolve => gateway.once('ready', resolve))
    socket.push({ op: OP.HELLO, d: { heartbeat_interval: 25 } })
    socket.push({ op: OP.DISPATCH, s: 1, t: 'READY', d: { session_id: 'S' } })
    await ready

    assert.ok(await waitFor(() => socket.closeCalls.length > 0 || socket.terminated, 1_000), '假死应触发重连')
    assert.equal(socket.closeCalls[0]?.reason, 'heartbeat timeout')
    assert.ok(
      warnings.some(text => text.includes('心跳连续两个周期没有回执')),
      '应当留下判定假死的日志',
    )
  } finally {
    await gateway.stop()
    await running
  }
})

test('心跳有回执时连接一直保持', async () => {
  FakeSocket.reset()
  const gateway = makeGateway({ minHeartbeatMs: 20, connectTimeoutMs: 5_000, handshakeTimeoutMs: 5_000 })
  const running = gateway.start()
  try {
    assert.ok(await waitFor(() => FakeSocket.instances.length === 1))
    const socket = FakeSocket.instances[0]
    const ready = new Promise(resolve => gateway.once('ready', resolve))
    socket.push({ op: OP.HELLO, d: { heartbeat_interval: 25 } })
    socket.push({ op: OP.DISPATCH, s: 1, t: 'READY', d: { session_id: 'S' } })
    await ready

    const timer = setInterval(() => socket.push({ op: OP.HEARTBEAT_ACK }), 10)
    await delay(200)
    clearInterval(timer)

    assert.equal(socket.closeCalls.length, 0, '有回执就不该重连')
    assert.ok(socket.sent.some(frame => frame.op === OP.HEARTBEAT), '心跳应该发出去了')
  } finally {
    await gateway.stop()
    await running
  }
})

test('断线后按退避等待再重连，close 事件不会提前叫醒退避', async () => {
  FakeSocket.reset()
  const gateway = makeGateway({ connectTimeoutMs: 5_000, handshakeTimeoutMs: 5_000, backoff: [120] })
  const running = gateway.start()
  try {
    assert.ok(await waitFor(() => FakeSocket.instances.length === 1))
    const first = FakeSocket.instances[0]
    await readied(gateway, first)

    const closedAt = Date.now()
    first.close(4009, 'test close')

    assert.ok(await waitFor(() => FakeSocket.instances.length === 2, 1_000), '应该重连')
    const elapsed = Date.now() - closedAt
    assert.ok(elapsed >= 100, `重连应等待退避时间，实际 ${elapsed}ms`)
  } finally {
    await gateway.stop()
    await running
  }
})

test('已建立的连接掉线时会上报 offline，状态面板不会一直假装在线', async () => {
  FakeSocket.reset()
  const gateway = makeGateway({ connectTimeoutMs: 5_000, handshakeTimeoutMs: 5_000, backoff: [200] })
  const offline = []
  gateway.on('offline', (code, reason) => offline.push(`${code} ${reason}`))
  const running = gateway.start()
  try {
    assert.ok(await waitFor(() => FakeSocket.instances.length === 1))
    const socket = FakeSocket.instances[0]
    await readied(gateway, socket)
    assert.equal(offline.length, 0, '连接正常时不该报离线')

    socket.close(4009, '连接过期')
    assert.ok(await waitFor(() => offline.length === 1), '掉线必须上报 offline')
    assert.equal(offline[0], '4009 连接过期')
  } finally {
    await gateway.stop()
    await running
  }
  assert.equal(offline.length, 1, 'stop() 主动断开不该被当成掉线')
})

test('旧连接的 close 迟到时不会踩掉新连接的看门狗', async () => {
  FakeSocket.reset()
  // 第一条永远连不上、close 还迟到；第二条是正常连接
  let created = 0
  function FlakyCtor(url, opts) {
    created += 1
    return created === 1 ? new SlowCloseSocket(url, opts) : new FakeSocket(url, opts)
  }

  const gateway = new QQBotGateway({
    api: makeApi(),
    intents: 1,
    ua: 'test-agent',
    connectTimeoutMs: 30,
    handshakeTimeoutMs: 5_000,
    backoff: [10],
    wsImpl: { Ctor: FlakyCtor, native: false },
  })
  const running = gateway.start()
  try {
    assert.ok(await waitFor(() => FakeSocket.instances.length === 2, 1_000), '第一条超时后应重连')
    const [first, second] = FakeSocket.instances
    assert.notEqual(first, second)

    // 等第一条的 close 事件迟到抵达（terminate 后 80ms）
    await delay(150)
    assert.equal(gateway.ws, second, 'this.ws 不能被旧连接的 close 清掉')
    assert.equal(gateway.connected, true)
    assert.equal(second.closeCalls.length, 0, '新连接不该被旧连接的 close 波及')
  } finally {
    await gateway.stop()
    await running
  }
})
