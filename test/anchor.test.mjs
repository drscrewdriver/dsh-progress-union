/**
 * Phase 3 验收：progressAnchor 锚点——schema 全集 / 双平面字节同形 / 同态 /
 * rev 对账 / userEdits 硬约束可见 / projection 判脏。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'union-test-'))
const { SESSION, createHarness, jsonReq, callRoute } = await import('./harness.mjs')

async function booted() {
  const harness = createHarness()
  await harness.run()
  await callRoute(harness, '/progress-union/active', jsonReq('POST', '/progress-union/active', { sessionId: SESSION, active: true, source: 'command' }))
  return harness
}

function execUpdate(harness, args) {
  return harness.toolMap.get('progress_update').definition.execute(args, { agent: harness.agent })
}

function anchorOf(harness, atMs) {
  return harness.provided.get('progressAnchor').get(SESSION, atMs)
}

test('schema 全集：version=1 字段齐、类型对、slotTrail 预留为 null', async () => {
  const harness = await booted()
  await execUpdate(harness, { changes: [{ title: '甲', status: 'doing', current: '写代码', next: '测试' }] })
  harness.emit('turn/start', {})
  const anchor = anchorOf(harness)
  assert.equal(anchor.version, 1)
  assert.equal(anchor.sessionId, SESSION)
  assert.equal(typeof anchor.revision, 'number')
  assert.equal(typeof anchor.updatedAt, 'number')
  assert.deepEqual(Object.keys(anchor.board).sort(), ['enabled', 'inFlight', 'pendingUserChanges', 'summary'])
  assert.deepEqual(Object.keys(anchor.board.summary).sort(), ['blocked', 'doing', 'done', 'percent', 'todo', 'total'])
  assert.deepEqual(Object.keys(anchor.board.inFlight[0]).sort(), ['current', 'id', 'next', 'percent', 'status', 'title'])
  assert.deepEqual(Object.keys(anchor.time).sort(), ['elapsedSec', 'etaBasis', 'etaMin', 'etaP75Min', 'overMin', 'staleMin', 'startedAt', 'steps', 'todoDone', 'todoTotal'])
  assert.equal(typeof anchor.persistent, 'boolean')
  assert.equal(anchor.slotTrail, null)
  assert.ok(Array.isArray(anchor.userEdits))
})

test('双平面字节同形 + 同态：同 (revision, now) service 与 HTTP 输出逐字节相等', async () => {
  const harness = await booted()
  await execUpdate(harness, { changes: [{ title: '甲', status: 'done' }, { title: '乙', status: 'doing' }] })
  harness.emit('turn/start', {})
  const started = anchorOf(harness).time.startedAt
  const fixed = started + 45_000

  const viaService = JSON.stringify(anchorOf(harness, fixed))
  const again = JSON.stringify(anchorOf(harness, fixed))
  assert.equal(viaService, again, '同 now 两次读取必须同字节（同态）')

  const res = await callRoute(harness, '/progress-union/anchor', {
    method: 'GET',
    url: `/progress-union/anchor?sessionId=${SESSION}&now=${fixed}`,
    headers: {},
  })
  assert.equal(res.status, 200)
  assert.equal(JSON.stringify(res.json().anchor), viaService, 'HTTP 与 service 双平面同形')
})

test('rev 对账：历史 progress_update 返回 rev < 当前锚点 rev ⇒ 该段已兑现可剪', async () => {
  const harness = await booted()
  const first = await execUpdate(harness, { changes: [{ title: '步骤一' }] })
  const second = await execUpdate(harness, { changes: [{ id: first.changed[0].id, status: 'done' }] })
  const anchor = anchorOf(harness)
  assert.equal(anchor.revision, second.revision)
  assert.ok(first.revision < anchor.revision, '第一段工具返回 rev 已被锚点覆盖（可安全剪）')
  assert.ok(second.changed.length >= 1)
})

test('userEdits 硬约束：pending>0 必出条目；超 20 条封顶；长值压缩 240+…', async () => {
  const harness = await booted()
  const added = await execUpdate(harness, { changes: [{ title: '任务', approach: 'x'.repeat(600) }] })
  const itemId = added.changed[0].id
  for (let i = 0; i < 25; i++) {
    await callRoute(harness, '/progress-union/action', jsonReq('POST', '/progress-union/action', { sessionId: SESSION, changes: [{ id: itemId, note: `改动 ${i}` }] }))
  }
  const anchor = anchorOf(harness)
  assert.equal(anchor.board.pendingUserChanges, 25)
  assert.equal(anchor.userEdits.length, 20, '注入体积有界（最近 20 条）')
  assert.equal(anchor.userEdits[anchor.userEdits.length - 1].kind, 'edit')
  const longField = anchor.userEdits.flatMap((e) => e.fields).find((f) => typeof f.to === 'string' && f.to.length > 200)
  assert.equal(longField, undefined, 'userEdits 只含用户改动；agent 建立的长 approach 不在其中')

  // ack 后清空
  await execUpdate(harness, { changes: [], ackUserRevision: anchor.revision })
  const after = anchorOf(harness)
  assert.equal(after.board.pendingUserChanges, 0)
  assert.equal(after.userEdits.length, 0)
})

test('空会话锚点：revision=0、board 关闭、etaBasis=none、userEdits 空', () => {
  const fresh = createHarness()
  return fresh.run().then(() => {
    const anchor = fresh.provided.get('progressAnchor').get('session-nope')
    assert.equal(anchor.revision, 0)
    assert.equal(anchor.board.enabled, false)
    assert.equal(anchor.board.summary.total, 0)
    assert.equal(anchor.time.etaBasis, 'none')
    assert.deepEqual(anchor.board.inFlight, [])
    assert.deepEqual(anchor.userEdits, [])
  })
})

test('projection progressAnchor：注册、init 形状、未变同引用、板写后重建', async () => {
  const harness = await booted()
  const proj = harness.projections.get('progressAnchor')
  assert.ok(proj, 'sessionProjections 可得时必须注册 progressAnchor')
  const state0 = proj.init()
  assert.equal(state0.version, 1)
  assert.ok(state0.sessions.some((s) => s.sessionId === SESSION && s.enabled === true))

  const state1 = proj.apply(state0, { type: 'user/message', data: {} })
  assert.equal(state1, state0, 'agg 未变必须返回同引用（不 republish）')

  await execUpdate(harness, { changes: [{ title: '新任务', status: 'doing' }] })
  const state2 = proj.apply(state1, { type: 'tool/result', data: {} })
  assert.notEqual(state2, state1, '板写入后 agg 变，必须重建')
  const row = state2.sessions.find((s) => s.sessionId === SESSION)
  assert.equal(row.revision, 1)
  assert.equal(row.summary.doing, 1)
  assert.doesNotThrow(() => proj.stateSchema.parse(state2))
  assert.doesNotThrow(() => proj.wire.viewSchema.parse(state2))
  assert.throws(() => proj.stateSchema.parse({ version: 1, agg: 'bad', sessions: [] }))
})

test('list() 面：多会话聚合可用', async () => {
  const harness = await booted()
  await callRoute(harness, '/progress-union/active', jsonReq('POST', '/progress-union/active', { sessionId: 'session-other', active: true, source: 'command' }))
  const list = harness.provided.get('progressAnchor').list(Date.now())
  assert.ok(Array.isArray(list))
  assert.deepEqual(list.map((a) => a.sessionId).sort(), [SESSION, 'session-other'].sort())
})
