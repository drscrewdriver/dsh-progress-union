/**
 * Phase 8 验收：辅助 LLM（审查/监视）通道。
 * - 直连端点、滞后触发、只改 current/next/percent（updatedBy=assistant）；
 * - 每回合配额 + 最小间隔节流；失败静默入 assistantError；
 * - 快照只回非机密字段（apiKey 只回布尔）；关着时零 fetch。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'union-test-'))
const { SESSION, createHarness, jsonReq, callRoute } = await import('./harness.mjs')

function stubFetch(handler) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(url, init, calls.length)
  }
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

function proposal(content) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { choices: [{ message: { content } }] }
    },
  }
}

async function booted(config) {
  const harness = createHarness({ config })
  await harness.run()
  await callRoute(harness, '/progress-union/active', jsonReq('POST', '/progress-union/active', { sessionId: SESSION, active: true, source: 'command' }))
  return harness
}

function execUpdate(harness, args) {
  return harness.toolMap.get('progress_update').definition.execute(args, { agent: harness.agent })
}

async function settle(ms = 30) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function snapshotOf(harness) {
  const res = await callRoute(harness, '/progress-union/snapshot', { method: 'GET', url: `/progress-union/snapshot?sessionId=${SESSION}`, headers: {} })
  return res.json()
}

test('命中的提议落地：只改 current/percent，updatedBy=assistant，快照不含密钥明文', async () => {
  const harness = await booted({
    assistant: { mode: 'direct', baseUrl: 'http://127.0.0.1:9999/v1', apiKey: 'sekret', model: 'mini', minIntervalMs: 0, maxCallsPerTurn: 1, timeoutMs: 5000 },
  })
  const added = await execUpdate(harness, { changes: [{ title: '造帧', status: 'doing', percent: 10, current: '热身' }] })
  const itemId = added.changed[0].id
  const stub = stubFetch(() => proposal('```json\n{"board":{"changes":[{"kind":"edit","id":"' + itemId + '","current":"审查：跑集成测试","percent":60},{"kind":"edit","id":"p_fake","current":"x"}]},"round":{"status":"continue","summary":"推进中"},"note":"滞后 6 步，已校准"}\n```'))
  try {
    harness.emit('tool/call', { name: 'Bash', arguments: JSON.stringify({ command: 'npm test' }) })
    for (let i = 0; i < 6; i++) harness.emit('step/start', {})
    await settle()
    assert.equal(stub.calls.length, 1, '滞后触发一次审查')
    assert.ok(stub.calls[0].url.endsWith('/chat/completions'))
    assert.equal(stub.calls[0].init.headers.authorization, 'Bearer sekret')

    const snap = await snapshotOf(harness)
    const item = snap.items.find((x) => x.id === itemId)
    assert.equal(item.current, '审查：跑集成测试')
    assert.equal(item.percent, 60)
    assert.equal(item.status, 'doing', '审查不得改状态')
    assert.equal(item.updatedBy, 'assistant')
    assert.equal(snap.items.length, 1, '不存在的 id 被丢弃，不得新增任务')

    assert.equal(snap.assistant.enabled, true)
    assert.equal(snap.assistant.hasApiKey, true)
    assert.equal('apiKey' in snap.assistant, false, '密钥不得回传')
    assert.match(harness.contexts.get('progress-union-observer')(), /助手审查：滞后 6 步，已校准/)
  } finally {
    stub.restore()
  }
})

test('关着时零 fetch；autoApply=false 只记录建议不落地', async () => {
  const off = await booted()
  await execUpdate(off, { changes: [{ title: '任务', status: 'doing' }] })
  const stubOff = stubFetch(() => proposal('{"changes":[],"note":"x"}'))
  try {
    for (let i = 0; i < 6; i++) off.emit('step/start', {})
    await settle()
    assert.equal(stubOff.calls.length, 0, '未启用不得发起请求')
    assert.equal((await snapshotOf(off)).assistant.enabled, false)
  } finally {
    stubOff.restore()
  }

  const dry = await booted({ assistant: { mode: 'direct', baseUrl: 'http://127.0.0.1:9999/v1', model: 'mini', minIntervalMs: 0, autoApply: false } })
  const added = await execUpdate(dry, { changes: [{ title: '任务', status: 'doing', percent: 10, current: '原样' }] })
  const itemId = added.changed[0].id
  const stubDry = stubFetch(() => proposal('{"board":{"changes":[{"kind":"edit","id":"' + itemId + '","percent":90}]},"round":{"status":"continue"},"note":"建议 90%"}'))
  try {
    for (let i = 0; i < 6; i++) dry.emit('step/start', {})
    await settle()
    const snap = await snapshotOf(dry)
    assert.equal(snap.items[0].percent, 10, 'autoApply=false 不落地')
    assert.match(dry.contexts.get('progress-union-observer')(), /助手审查：建议 90%/)
  } finally {
    stubDry.restore()
  }
})

test('失败静默：HTTP 错误/坏 JSON 只进 assistantError，不阻断板', async () => {
  const harness = await booted({ assistant: { mode: 'direct', baseUrl: 'http://127.0.0.1:9999/v1', model: 'mini', minIntervalMs: 0 } })
  await execUpdate(harness, { changes: [{ title: '任务', status: 'doing' }] })
  const stub = stubFetch(() => ({ ok: false, status: 503, async json() { return {} } }))
  try {
    for (let i = 0; i < 6; i++) harness.emit('step/start', {})
    await settle()
    const text = harness.contexts.get('progress-union-observer')()
    assert.match(text, /助手审查失败：HTTP 503/)
    assert.equal((await snapshotOf(harness)).items[0].status, 'doing', '板本体不受影响')
  } finally {
    stub.restore()
  }
})

test('节流与每回合配额：minIntervalMs 内不再发；新回合重置配额', async () => {
  const harness = await booted({ assistant: { mode: 'direct', baseUrl: 'http://127.0.0.1:9999/v1', model: 'mini', minIntervalMs: 60_000, maxCallsPerTurn: 1 } })
  await execUpdate(harness, { changes: [{ title: '任务', status: 'doing' }] })
  const stub = stubFetch(() => proposal('{"changes":[],"note":"ok"}'))
  try {
    for (let i = 0; i < 6; i++) harness.emit('step/start', {})
    await settle()
    assert.equal(stub.calls.length, 1)
    for (let i = 0; i < 6; i++) harness.emit('step/start', {})
    await settle()
    assert.equal(stub.calls.length, 1, '最小间隔内不得重发')
  } finally {
    stub.restore()
  }
})

test('assistant 逐叶子 volatile：live ref 每回合重读，改值不需重启', async () => {
  const ref = (getter) => ({ get: getter })
  const live = { mode: 'direct', baseUrl: 'http://127.0.0.1:9999/v1', model: 'mini' }
  const harness = createHarness({
    config: {
      assistant: {
        mode: ref(() => live.mode),
        baseUrl: ref(() => live.baseUrl),
        model: ref(() => live.model),
        minIntervalMs: ref(() => 0),
      },
    },
  })
  await harness.run()
  const on = await snapshotOf(harness)
  assert.equal(on.assistant.mode, 'direct')
  assert.equal(on.assistant.enabled, true)
  live.mode = ''
  const off = await snapshotOf(harness)
  assert.equal(off.assistant.enabled, false, '设置页关掉后下一次读即生效')
})
test('registered 模式：走宿主 llm.stream（system 走 options.system，content 为块数组），消费 text-delta + 槽位管理 + 轮次草案', async () => {
  const streamCalls = []
  const llm = {
    async *stream(options) {
      streamCalls.push(options)
      yield { type: 'text-delta', text: '{}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const harness = createHarness({
    config: { assistant: { mode: 'registered', provider: 'local', model: 'qwen', minIntervalMs: 0, maxCallsPerTurn: 1 } },
    llm,
  })
  await harness.run()
  await callRoute(harness, '/progress-union/active', jsonReq('POST', '/progress-union/active', { sessionId: SESSION, active: true, source: 'command' }))
  const added = await execUpdate(harness, { changes: [{ title: '任务', status: 'doing', percent: 10 }] })
  const itemId = added.changed[0].id
  llm.stream = async function* (options) {
    streamCalls.push(options)
    yield { type: 'text-delta', text: '{"board":{"changes":[' }
    yield { type: 'text-delta', text: `{"kind":"edit","id":"${itemId}","percent":75}` }
    yield { type: 'text-delta', text: ']},"round":{"status":"continue","summary":"推进中"},"note":"registered 校准"}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  for (let i = 0; i < 6; i++) harness.emit('step/start', {})
  await settle()
  assert.equal(streamCalls.length, 1, 'registered 走 llm.stream 而非 fetch')
  assert.equal(streamCalls[0].provider, 'local')
  assert.equal(streamCalls[0].model, 'qwen')
  // 契约守卫（2026-11-26 事故回归）：system 必须在 options.system，不能藏在 messages 里，
  // 否则 adapter 不映射 system 槽 → DeepSeek 回落到内置 "You are a helpful assistant."
  assert.equal(typeof streamCalls[0].system, 'string')
  assert.match(streamCalls[0].system, /progress assistant/, 'system 必须是 ASSISTANT_SYSTEM 正文')
  assert.deepEqual(streamCalls[0].messages.map((m) => m.role), ['user'], 'messages 里不得出现 role:system')
  const blocks = streamCalls[0].messages[0].content
  assert.ok(Array.isArray(blocks), 'content 必须是 ContentBlock[]，不能是裸字符串')
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /目标|\[~\]/, '输入正文必须带上板清单')
  const snap = await snapshotOf(harness)
  assert.equal(snap.items[0].percent, 75, '助手改了槽位')
  assert.equal(snap.items[0].updatedBy, 'assistant')
  assert.match(harness.contexts.get('progress-union-observer')(), /助手轮次草案.*推进中/)
})