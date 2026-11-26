/**
 * v0.4.0 消费者视角验收：
 * - 经 service get/list 读锚点并断言字段；
 * - 经 subscribe 拿到板变更通知（revision 递增、同 rev 不重复、退订后零回调）；
 * - isAnchor/anchorLine 对新旧快照都能工作（含未启用板场景）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'union-test-'))
const { SESSION, createHarness, jsonReq, callRoute } = await import('./harness.mjs')
const { ANCHOR_VERSION, ANCHOR_ROUTES, BOARD_STATUSES, isAnchor, anchorLine } = await import('../anchor.js')

function execUpdate(harness, args) {
  return harness.toolMap.get('progress_update').definition.execute(args, { agent: harness.agent })
}

async function booted() {
  const harness = createHarness()
  await harness.run()
  await callRoute(harness, '/progress-union/active', jsonReq('POST', '/progress-union/active', { sessionId: SESSION, active: true, source: 'command' }))
  return harness
}

test('./anchor 子路径导出齐全；常量与 service.version 握手一致', async () => {
  assert.equal(ANCHOR_VERSION, 1)
  assert.deepEqual(ANCHOR_ROUTES, {
    anchor: '/progress-union/anchor',
    snapshot: '/progress-union/snapshot',
    status: '/dsh-progress/status',
  })
  assert.deepEqual(BOARD_STATUSES, ['todo', 'doing', 'done', 'blocked'])
  assert.equal(typeof isAnchor, 'function')
  assert.equal(typeof anchorLine, 'function')
  const harness = await booted()
  assert.equal(harness.provided.get('progressAnchor').version, ANCHOR_VERSION, '握手：service.version === ANCHOR_VERSION')
})

test('消费者经 get/list 读锚点：字段齐、未启用板 board.enabled=false 不抛', async () => {
  const harness = await booted()
  const service = harness.provided.get('progressAnchor')
  const anchor = service.get(SESSION)
  assert.equal(isAnchor(anchor), true)
  assert.equal(anchor.sessionId, SESSION)
  assert.equal(typeof anchor.revision, 'number')
  assert.equal(typeof anchor.board.enabled, 'boolean')
  const listed = service.list()
  assert.ok(Array.isArray(listed))
  assert.ok(listed.some((a) => a.sessionId === SESSION))

  const off = createHarness()
  await off.run()
  const disabled = off.provided.get('progressAnchor').get('session-never-enabled')
  assert.equal(isAnchor(disabled), true, '未启用板仍是合法锚点')
  assert.equal(disabled.board.enabled, false)
  assert.equal(anchorLine(disabled), '0% 0/0', '未启用板不抛错，给 0 值摘要')
})

test('subscribe：板 revision 递增回调一次；同 revision 不重复；退订后零回调', async () => {
  const harness = await booted()
  const service = harness.provided.get('progressAnchor')
  const events = []
  const off = service.subscribe((evt) => events.push(evt), SESSION)

  await execUpdate(harness, { changes: [{ title: '甲', status: 'doing' }] })
  await execUpdate(harness, { changes: [{ title: '乙', status: 'todo' }] })
  assert.equal(events.length, 2, '两次写板、两次不同 revision → 两次回调')
  assert.ok(events[0].revision < events[1].revision)
  assert.equal(events[0].sessionId, SESSION)

  // 同 revision 不重复：先记下当前 revision，重复订阅探测不会因读操作再触发。
  const rev = events[1].revision
  assert.equal(events.filter((e) => e.revision === rev).length, 1)

  off()
  await execUpdate(harness, { changes: [{ title: '丙' }] })
  assert.equal(events.length, 2, '退订后不再回调')

  // 无参数订阅（全会话）也应可退订。
  const all = []
  const offAll = service.subscribe((evt) => all.push(evt))
  await execUpdate(harness, { changes: [{ title: '丁', status: 'done' }] })
  assert.equal(all.length, 1)
  offAll()
  await execUpdate(harness, { changes: [{ title: '戊' }] })
  assert.equal(all.length, 1)
})

test('isAnchor/anchorLine：新旧快照都能工作（缺新字段不抛，坏形状返回空串）', async () => {
  const modern = { version: 1, sessionId: 's', board: { enabled: true, summary: { percent: 45, done: 3, total: 7 } }, time: { etaMin: 6, staleMin: 12 } }
  const legacy = { version: 1, sessionId: 's', board: { enabled: true, summary: { percent: 80, done: 4, total: 5, doing: 0, todo: 1, blocked: 0 } }, time: { staleMin: 0 } }
  assert.equal(isAnchor(modern), true)
  assert.equal(isAnchor(legacy), true)
  assert.equal(anchorLine(modern), '45% 3/7 · ETA 6m · stale 12m')
  assert.equal(anchorLine(legacy), '80% 4/5')
  assert.equal(isAnchor({ version: 1, sessionId: 's', board: {}, time: {} }), false)
  assert.equal(anchorLine(null), '')
})
