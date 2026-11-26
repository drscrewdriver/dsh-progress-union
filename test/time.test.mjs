/**
 * Phase 2 验收：时间引擎（事件层 + ETA 三档回落 + 协议收敛 + cooldown/stale）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'union-test-'))
const { SESSION, createHarness, jsonReq, callRoute, withClock } = await import('./harness.mjs')

async function booted() {
  const harness = createHarness()
  await harness.run()
  await callRoute(harness, '/progress-union/active', jsonReq('POST', '/progress-union/active', { sessionId: SESSION, active: true, source: 'command' }))
  return harness
}

function execUpdate(harness, args) {
  const tool = harness.toolMap.get('progress_update')
  return tool.definition.execute(args, { agent: harness.agent })
}

function anchorOf(harness, atMs) {
  return harness.provided.get('progressAnchor').get(SESSION, atMs)
}

test('turn/start + step/start 驱动 steps/elapsed；无板无 todo 走 prior', async () => {
  const harness = createHarness()
  await harness.run()
  harness.emit('turn/start', {})
  for (let i = 0; i < 4; i++) harness.emit('step/start', {})
  const started = anchorOf(harness).time.startedAt
  assert.ok(started > 0)
  const at = started + 60_000
  const anchor = anchorOf(harness, at)
  assert.equal(anchor.time.steps, 4)
  assert.equal(anchor.time.elapsedSec, 60)
  assert.equal(anchor.time.etaBasis, 'prior') // 临时 DSH_HOME 无学习样本
  assert.equal(anchor.time.todoTotal, 0)
})

test('board 档最优先：阶段取板、blocked 不计剩余', async () => {
  const harness = await booted()
  const added = await execUpdate(harness, {
    changes: [
      { title: '甲', status: 'done' },
      { title: '乙', status: 'blocked', note: '等人确认' },
      { title: '丙', status: 'todo' },
    ],
  })
  harness.emit('turn/start', {})
  const started = anchorOf(harness).time.startedAt
  const at = started + 60_000 // elapsed 60s, done=1 → perItemSec=60, left=1(丙) → p50=60
  const anchor = anchorOf(harness, at)
  assert.equal(anchor.time.etaBasis, 'board')
  assert.equal(anchor.time.elapsedSec, 60)
  // p50=60 → remain=max(5,60-36)/60=0.4min → etaMin=max(0,round(.4))=0
  assert.equal(anchor.time.etaMin, 0)
  // inFlight 含 blocked（等人不是等时间，但要出现在锚点）
  assert.deepEqual(anchor.board.inFlight.map((i) => i.status), ['blocked'])
  assert.equal(anchor.board.summary.total, 3)
  assert.equal(anchor.board.summary.done, 1)
  void added

  // /dsh-progress/status：板开时阶段直接取 items 标题（不再关键词猜测）
  const res = await callRoute(harness, '/dsh-progress/status', { method: 'GET', url: '/dsh-progress/status', headers: {} })
  const task = res.json().task
  assert.deepEqual(task.stages, ['甲', '乙', '丙'])
  assert.equal(task.boardDriven, true)
  assert.equal(task.autoStage, false)
})

test('todo 档：板关闭时用官方 todo 完成度', async () => {
  const harness = createHarness()
  await harness.run()
  harness.emit('turn/start', {})
  harness.emit('todo/write', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }, { content: 'c', status: 'pending' }, { content: 'd', status: 'pending' }] })
  const started = anchorOf(harness).time.startedAt
  const at = started + 120_000 // perItemSec=60, left=2 → p50=120
  const anchor = anchorOf(harness, at)
  assert.equal(anchor.time.etaBasis, 'todo')
  assert.equal(anchor.time.todoDone, 2)
  assert.equal(anchor.time.todoTotal, 4)
  // p50=120, elapsed=120 → max(5,120-72)=48s → etaMin=1
  assert.equal(anchor.time.etaMin, 1)
})

test('kickoff 冷却：全完成后一回合只推一次', async () => {
  const harness = await booted()
  await execUpdate(harness, { changes: [{ title: '唯一任务', status: 'done' }] })
  const kickoff = harness.contexts.get('progress-union-kickoff')
  const first = kickoff()
  assert.match(first, /已全部完成/)
  assert.equal(kickoff(), '', '60s 冷却内不得重复推')
  void harness
})

test('stale：板开 13 分钟未更新 → anchor.time.staleMin ≥ 11', async () => {
  const harness = await booted()
  await execUpdate(harness, { changes: [{ title: '任务', status: 'doing', current: '在做' }] })
  const base = Date.now()
  const anchor = anchorOf(harness, base + 13 * 60 * 1000)
  assert.equal(anchor.time.staleMin, 13)
  assert.equal(anchor.board.inFlight[0].status, 'doing')
})

test('单协议收敛：板开不注入文件上报协议，板关注入且 kind=plugin:dsh-progress-union', async () => {
  const clock = withClock()
  try {
    // 板开
    const on = await booted()
    const preStep = on.agentHooks.find((h) => h.type === 'agent/pre-step')
    assert.ok(preStep, 'agent/created 应装 pre-step 钩子')
    const freshUser = { source: { kind: 'user' } }
    const decision = { kind: 'enter', messages: [freshUser] }
    const out = await preStep.handler({ messages: [freshUser] }, async () => decision)
    assert.equal(out.messages.length, 1, '板开时不得追加协议消息')

    // 板关（全新 harness 不启用）
    const off = createHarness()
    await off.run()
    const preStepOff = off.agentHooks.find((h) => h.type === 'agent/pre-step')
    const decisionOff = { kind: 'enter', messages: [{ source: { kind: 'user' } }] }
    const outOff = await preStepOff.handler({ messages: [{ source: { kind: 'user' } }] }, async () => decisionOff)
    assert.equal(outOff.messages.length, 2)
    const injected = outOff.messages[1]
    assert.equal(injected.source.kind, 'plugin:dsh-progress-union')
    assert.match(injected.content[0].text, /dsh-progress/)
  } finally {
    clock.restore()
  }
})

test('turn/end 收任务并学样本；结束后锚点时间层归零但不丢 steps', async () => {
  const harness = createHarness()
  await harness.run()
  harness.emit('turn/start', {})
  harness.emit('step/start', {})
  harness.emit('step/start', {})
  harness.emit('turn/end', {})
  const anchor = anchorOf(harness, Date.now() + 3600_000)
  assert.equal(anchor.time.startedAt, 0, '任务已结束不应再给进行中锚')
  assert.equal(anchor.time.etaBasis, 'none')
  assert.equal(anchor.time.elapsedSec, 0)
})
