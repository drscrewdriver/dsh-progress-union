/**
 * v0.3.0 验收：板 → 官方 todo 镜像 + 助手冲突裁决。
 * - 映射（done→completed / 首条 doing→in_progress / todo+blocked→pending、content 唯一）；
 * - 200ms 去抖单次写入、回环不触发裁决、off 不写、无 append 静默降级；
 * - 三种 resolution 落地与助手失败两侧不改。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'union-test-'))
const { SESSION, createHarness, jsonReq, callRoute } = await import('./harness.mjs')

async function booted(config = {}) {
  const harness = createHarness({ config: { ...config, todo: { mirrorThrottleMs: 5, ...(config.todo || {}) } } })
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

function stubFetch(handler) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(url, init, calls.length)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

function proposal(content) {
  return { ok: true, status: 200, async json() { return { choices: [{ message: { content } }] } } }
}

async function snapshot(harness) {
  const res = await callRoute(harness, '/progress-union/snapshot', { method: 'GET', url: `/progress-union/snapshot?sessionId=${SESSION}`, headers: {} })
  return res.json()
}

test('映射：done→completed、仅首条 doing→in_progress、todo/blocked→pending、content 去重、in_progress≤1', async () => {
  const harness = await booted()
  await execUpdate(harness, { changes: [
    { title: '甲', status: 'done' },
    { title: '乙', status: 'doing' },
    { title: '丙', status: 'doing' },
    { title: '丁', status: 'blocked' },
    { title: '乙', status: 'todo' }, // 重复标题，需去重
  ] })
  await settle()
  const writes = harness.appends.filter((w) => w.type === 'todo/write')
  assert.equal(writes.length, 1, '去抖后只写一次')
  const todos = writes[0].data.todos
  assert.deepEqual(todos.map((t) => t.status), ['completed', 'pending', 'in_progress', 'pending'])
  assert.deepEqual(todos.map((t) => t.content), ['甲', '乙', '丙', '丁'])
  assert.equal(todos.filter((t) => t.status === 'in_progress').length, 1)
  assert.equal((await snapshot(harness)).todo.sync, 'reconcile')
})

test('去抖与回环：连续写板 5 次只镜像一次；自家 hash 命中不触发裁决', async () => {
  const harness = await booted({
    assistant: { mode: 'direct', baseUrl: 'http://127.0.0.1:9999/v1', model: 'mini', minIntervalMs: 0 },
  })
  const stub = stubFetch(() => proposal('{"resolution":"keep-board","note":"no-op"}'))
  try {
    for (let i = 0; i < 5; i += 1) await execUpdate(harness, { changes: [{ title: `任务${i}`, status: i === 0 ? 'doing' : 'todo' }] })
    await settle(50)
    const writes = harness.appends.filter((w) => w.type === 'todo/write')
    assert.equal(writes.length, 1, '5 次写板 → 1 次镜像')
    // 把镜像内容当自家事件回灌：hash 命中，零裁决
    harness.emit('todo/write', { todos: writes[0].data.todos })
    await settle()
    assert.equal(stub.calls.length, 0, '自家写入不得触发裁决')
  } finally {
    stub.restore()
  }
})

test('reconcile 三支：adopt-todo 覆盖板、keep-board 重镜像、merge 增量落地', async () => {
  for (const [resolution, body, expected] of [
    ['adopt-todo', '{"resolution":"adopt-todo","board":{"changes":[]},"note":"todo 更新"}', (snap) => assert.deepEqual(snap.items.map((i) => i.title).sort(), ['新任务'])],
    ['keep-board', '{"resolution":"keep-board","board":{"changes":[]},"note":"板为准"}', (snap) => assert.equal(snap.items[0].title, '原任务')],
    ['merge', '{"resolution":"merge","board":{"changes":[{"id":"__SELF__","percent":80}]},"note":"合并"}', (snap) => assert.equal(snap.items[0].percent, 80)],
  ]) {
    const harness = await booted({
      assistant: { mode: 'direct', baseUrl: 'http://127.0.0.1:9999/v1', model: 'mini', minIntervalMs: 0 },
      todo: { maxReconcileIntervalMs: 0 },
    })
    const added = await execUpdate(harness, { changes: [{ title: '原任务', status: 'doing', percent: 10 }] })
    const selfId = added.changed[0].id
    await settle() // 先镜像落定
    const stub = stubFetch(() => proposal(body.replace('__SELF__', selfId)))
    try {
      harness.emit('todo/write', { todos: [
        { content: resolution === 'adopt-todo' ? '新任务' : '外部任务', status: 'in_progress' },
      ] })
      await settle(60)
      const snap = await snapshot(harness)
      expected(snap)
      assert.match(harness.contexts.get('progress-union-observer')(), /todo 裁决：/)
    } finally {
      stub.restore()
    }
  }
})

test('助手失败/坏 JSON/未配置：两侧均不改，观察块出现漂移行', async () => {
  const harness = await booted({
    assistant: { mode: 'direct', baseUrl: 'http://127.0.0.1:9999/v1', model: 'mini', minIntervalMs: 0 },
    todo: { maxReconcileIntervalMs: 0 },
  })
  await execUpdate(harness, { changes: [{ title: '原任务', status: 'doing', percent: 10 }] })
  await settle()
  const snapBefore = await snapshot(harness)
  const stub = stubFetch(() => ({ ok: false, status: 503, async json() { return {} } }))
  try {
    harness.emit('todo/write', { todos: [
      { content: '外部任务', status: 'in_progress' },
      { content: '外部任务2', status: 'completed' },
    ] })
    await settle(60)
    const snapAfter = await snapshot(harness)
    assert.deepEqual(snapAfter.items, snapBefore.items, '失败不改板')
    assert.equal(harness.appends.length, 1, '失败不重新镜像')
    assert.match(harness.contexts.get('progress-union-observer')(), /\[todo 漂移\]/)
    assert.match(harness.contexts.get('progress-union-observer')(), /助手审查失败：HTTP 503/)
  } finally {
    stub.restore()
  }
})

test('todoSync=off 零写入；宿主无 session.append 静默降级', async () => {
  const off = await booted({ todoSync: 'off' })
  await execUpdate(off, { changes: [{ title: '任务', status: 'doing' }] })
  await settle(30)
  assert.equal(off.appends.length, 0, 'off 时零 todo/write')

  const harness = createHarness({ config: { todo: { mirrorThrottleMs: 5 } } })
  delete harness.agent.session.append // 旧宿主：无 append
  await harness.run()
  await callRoute(harness, '/progress-union/active', jsonReq('POST', '/progress-union/active', { sessionId: SESSION, active: true, source: 'command' }))
  await execUpdate(harness, { changes: [{ title: '任务', status: 'doing' }] })
  await settle(30)
  assert.equal((await snapshot(harness)).items.length, 1, '板不受影响')
  assert.equal((await snapshot(harness)).todo.unsupported, true, '快照标记 unsupported')
})
