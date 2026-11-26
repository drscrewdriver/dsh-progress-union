/**
 * Phase 7 验收：观察者（辅助观察最近输出/清单；板滞后及时补与催办）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'union-test-'))
const { SESSION, createHarness, jsonReq, callRoute, flush } = await import('./harness.mjs')

async function booted() {
  const harness = createHarness()
  await harness.run()
  await callRoute(harness, '/progress-union/active', jsonReq('POST', '/progress-union/active', { sessionId: SESSION, active: true, source: 'command' }))
  return harness
}

function execUpdate(harness, args) {
  return harness.toolMap.get('progress_update').definition.execute(args, { agent: harness.agent })
}

function observerText(harness) {
  const fn = harness.contexts.get('progress-union-observer')
  assert.ok(fn, 'progress-union-observer 上下文必须注册')
  return fn()
}

test('观察块：清单标记 + 最近输出 + 最近动作 + 官方 todo 行', async () => {
  const harness = await booted()
  await execUpdate(harness, {
    changes: [
      { title: '接口改造', status: 'done' },
      { title: '补集成测试', status: 'doing', current: '写 observer 用例', next: '跑全量' },
      { title: '发版', status: 'todo' },
    ],
  })
  harness.emit('assistant/message', { message: { content: [{ type: 'text', text: '接口改造已完成，接下来补测试。' }] } })
  harness.emit('tool/call', { name: 'Bash', arguments: JSON.stringify({ command: 'npm test' }) })
  harness.emit('todo/write', { todos: [
    { content: '接口改造', status: 'completed' },
    { content: '补集成测试', status: 'in_progress' },
    { content: '发版', status: 'pending' },
  ] })

  const text = observerText(harness)
  assert.match(text, /<progress-observer revision="1"/)
  assert.match(text, /\[x\] 接口改造/)
  assert.match(text, /\[~\] 补集成测试（0%） · 当前：写 observer 用例 · 下一步：跑全量/)
  assert.match(text, /\[ \] 发版/)
  assert.match(text, /最近输出：「接口改造已完成，接下来补测试。/)
  assert.match(text, /最近动作：Bash/)
  assert.match(text, /\[官方todo\] 完成 1\/3，未完：补集成测试、发版/)
  assert.doesNotMatch(text, /滞后/, '未超阈值不得催办')
})

test('滞后刚需：超 N 步未写板 → 催办出现；模型写板后消失', async () => {
  const harness = await booted()
  await execUpdate(harness, { changes: [{ title: '唯一任务', status: 'doing' }] })
  for (let i = 0; i < 6; i++) harness.emit('step/start', {})
  const text = observerText(harness)
  assert.match(text, /⚠ 进度已滞后（6 步前）/)
  assert.match(text, /先调用 progress_update 同步再继续/)

  // 模型自己同步（无变化确认也算）→ 催办消失
  await execUpdate(harness, { changes: [] })
  assert.doesNotMatch(observerText(harness), /滞后/)
})

test('观察者自动补 current：事实性最近动作写入 doing 项（updatedBy=observer），不抵消催办', async () => {
  const harness = await booted()
  const added = await execUpdate(harness, { changes: [{ title: '造帧', status: 'doing', current: '热身' }] })
  const itemId = added.changed[0].id
  harness.emit('tool/call', { name: 'Bash', arguments: JSON.stringify({ command: 'render --frames 900' }) })
  for (let i = 0; i < 6; i++) harness.emit('step/start', {})
  await flush()

  const snap = (await callRoute(harness, '/progress-union/snapshot', { method: 'GET', url: `/progress-union/snapshot?sessionId=${SESSION}`, headers: {} })).json()
  const item = snap.items.find((x) => x.id === itemId)
  assert.match(item.current, /^自动同步：Bash · command=render --frames 900/)
  assert.equal(item.updatedBy, 'observer')
  assert.equal(item.status, 'doing', '观察者不得改状态')
  assert.ok(snap.revision >= 2)

  // 自动补不重置\"模型同步\"计数：催办仍在（状态/百分比仍需模型确认）
  assert.match(observerText(harness), /⚠ 进度已滞后/)
})

test('progress_update 拉通道：返回 inFlight 明细 + time 字段', async () => {
  const harness = await booted()
  const r = await execUpdate(harness, {
    changes: [
      { title: '甲', status: 'done' },
      { title: '乙', status: 'doing', current: '做乙', next: '做丙' },
      { title: '丙', status: 'blocked', note: '等确认' },
    ],
  })
  assert.equal(r.inFlight.length, 2)
  assert.deepEqual(r.inFlight.map((x) => x.status), ['doing', 'blocked'])
  assert.equal(typeof r.time.etaBasis, 'string')
  assert.equal(typeof r.time.steps, 'number')
  assert.equal(typeof r.time.staleMin, 'number')
})

test('最近改动：带路径的工具调用入块，同路径去重、只留最近 4 个', async () => {
  const harness = await booted()
  await execUpdate(harness, { changes: [{ title: '改代码', status: 'doing' }] })
  const call = (file, tool = 'Edit') => harness.emit('tool/call', { name: tool, arguments: JSON.stringify({ file_path: file }) })
  call('E:\\proj\\src\\a.ts')
  call('E:\\proj\\src\\b.ts', 'Write')
  call('E:\\proj\\src\\a.ts') // 同路径去重，留最新
  call('E:\\proj\\src\\c.ts')
  call('E:\\proj\\src\\d.ts')
  call('E:\\proj\\src\\e.ts')

  const text = observerText(harness)
  const line = text.split('\n').find((l) => l.startsWith('最近改动：'))
  assert.ok(line, '最近改动行必须存在')
  assert.equal((line.match(/（/g) || []).length, 4, '最多 4 条')
  assert.doesNotMatch(line, /b\.ts/, '被后 4 条挤出（上限保留最近）')
  assert.match(line, /a\.ts（Edit）/, '同路径重写后保留最新一条')
  assert.equal((line.match(/a\.ts/g) || []).length, 1, '同路径只出现一次（去重）')
})

test('清单对比：todo 与板完成数漂移才出对比行（算术，非语义）', async () => {
  const harness = await booted()
  await execUpdate(harness, {
    changes: [{ title: '甲', status: 'done' }, { title: '乙', status: 'doing' }, { title: '丙', status: 'todo' }],
  })
  harness.emit('todo/write', { todos: [
    { content: '甲', status: 'completed' },
    { content: '乙', status: 'completed' },
    { content: '丙', status: 'pending' },
  ] })
  const drifted = observerText(harness)
  assert.match(drifted, /对比：官方 todo 完成 2\/3 · 板完成 1\/3（进度不一致/)

  // 对齐后不再出对比行
  await execUpdate(harness, { changes: [{ title: '乙', status: 'done' }] })
  assert.doesNotMatch(observerText(harness), /对比：/)
})

test('观察者自补的 current 在块里标注待确认', async () => {
  const harness = await booted()
  await execUpdate(harness, { changes: [{ title: '造帧', status: 'doing', current: '热身' }] })
  harness.emit('tool/call', { name: 'Bash', arguments: JSON.stringify({ command: 'render' }) })
  for (let i = 0; i < 6; i++) harness.emit('step/start', {})
  await flush()
  assert.match(observerText(harness), /当前：自动同步：Bash · command=render（观察者补，待确认）/)
})

test('门控：关板/全完成/空板时观察块为空（0 token）', async () => {
  const harness = createHarness()
  await harness.run()
  assert.equal(observerText(harness), '', '未启用不得注入')

  await callRoute(harness, '/progress-union/active', jsonReq('POST', '/progress-union/active', { sessionId: SESSION, active: true, source: 'command' }))
  assert.equal(observerText(harness), '', '空板不注入（kickoff 负责）')

  await execUpdate(harness, { changes: [{ title: '唯一任务', status: 'done' }] })
  assert.equal(observerText(harness), '', '全完成不打扰')
})

test('可关：observer.enabled=false 时零注入', async () => {
  const harness = createHarness({ config: { observer: { enabled: false } } })
  await harness.run()
  await callRoute(harness, '/progress-union/active', jsonReq('POST', '/progress-union/active', { sessionId: SESSION, active: true, source: 'command' }))
  await execUpdate(harness, { changes: [{ title: '任务', status: 'doing' }] })
  assert.equal(observerText(harness), '')
})