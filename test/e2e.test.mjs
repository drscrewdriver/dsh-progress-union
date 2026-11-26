/**
 * Phase 5 端到端冒烟（task_22）：建板 → 用户改 → 不 ack 读锚点 → ack 后再读 →
 * 时钟推进 12 分钟读 staleMin；另验 KV 缺席时锚点仍出且 persistent=false。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'union-test-'))
const { SESSION, createHarness, jsonReq, callRoute, withClock } = await import('./harness.mjs')

function execUpdate(harness, args) {
  return harness.toolMap.get('progress_update').definition.execute(args, { agent: harness.agent })
}

test('端到端：建板→用户改→ack→陈旧推进，锚点各阶段状态正确迁移', async () => {
  const harness = createHarness()
  await harness.run()
  await callRoute(harness, '/progress-union/active', jsonReq('POST', '/progress-union/active', { sessionId: SESSION, active: true, source: 'command' }))
  const anchor = () => harness.provided.get('progressAnchor').get(SESSION)

  // 阶段 0：启用但空板
  assert.equal(anchor().board.summary.total, 0)
  assert.match(harness.contexts.get('progress-union-kickoff')(), /第一个工具调用必须是 progress_update/)

  // 阶段 1：建板（3 项，1 doing）
  const added = await execUpdate(harness, {
    changes: [{ title: '抓帧', status: 'doing', current: '渲染第 1/900 帧' }, { title: '合成' }, { title: '字幕' }],
  })
  assert.equal(added.summary.total, 3)
  assert.equal(anchor().board.inFlight.length, 1)
  assert.equal(anchor().board.inFlight[0].title, '抓帧')

  // 阶段 2：用户面板改"合成"备注 → pending=1，userEdits 出现，时间戳推进
  const itemId = (await callRoute(harness, '/progress-union/snapshot', { method: 'GET', url: `/progress-union/snapshot?sessionId=${SESSION}`, headers: {} })).json().items[1].id
  await callRoute(harness, '/progress-union/action', jsonReq('POST', '/progress-union/action', { sessionId: SESSION, changes: [{ id: itemId, note: '用 4K' }] }))
  const pending = anchor()
  assert.equal(pending.board.pendingUserChanges, 1)
  assert.equal(pending.userEdits[0].fields[0].field, 'note')
  assert.ok(pending.revision > added.revision)

  // 阶段 3：agent ack → pending=0，锚点 revision 不因确认增长
  const acked = await execUpdate(harness, { changes: [], ackUserRevision: pending.revision })
  assert.equal(acked.revision, pending.revision)
  assert.equal(anchor().board.pendingUserChanges, 0)
  assert.equal(anchor().userEdits.length, 0)

  // 阶段 4：真实时钟推进 12 分钟无更新 → staleMin=12 且 kickoff 提醒复现
  const clock = withClock()
  try {
    clock.advance(12 * 60 * 1000)
    const later = harness.provided.get('progressAnchor').get(SESSION)
    assert.equal(later.time.staleMin, 12)
    assert.match(harness.contexts.get('progress-union-kickoff')(), /12 分钟没有更新/)
  } finally {
    clock.restore()
  }

  // 阶段 5：完成推进 → percent 迁移
  await execUpdate(harness, { changes: [{ id: added.changed[0].id, status: 'done' }] })
  const afterDone = anchor()
  assert.equal(afterDone.board.summary.done, 1)
  assert.equal(afterDone.board.summary.percent, 33) // (100+0+0)/3
})

test('KV 缺席：内存态可用，锚点照出且 persistent=false', async () => {
  const harness = createHarness({ storageless: true })
  await harness.run()
  await callRoute(harness, '/progress-union/active', jsonReq('POST', '/progress-union/active', { sessionId: SESSION, active: true, source: 'command' }))
  await execUpdate(harness, { changes: [{ title: '仅内存', status: 'doing' }] })
  const anchor = harness.provided.get('progressAnchor').get(SESSION)
  assert.equal(anchor.persistent, false)
  assert.equal(anchor.board.summary.total, 1)
  assert.equal(anchor.board.inFlight[0].title, '仅内存')
})
