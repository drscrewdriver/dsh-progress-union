/**
 * Phase 1 验收：board 增量协议 + ack 语义（fork 自 dsh-progress-board 的协议断言）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 先钉住 DSH_HOME 再动态引入（index.js 模块求值时即读环境变量），避免测试碰真机 stats。
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'union-test-'))
const { SESSION, createHarness, jsonReq, callRoute, flush } = await import('./harness.mjs')

async function booted(config) {
  const harness = createHarness({ config })
  await harness.run()
  // 启用板（走 active 路由的 command 源，等价 /progress on）
  await callRoute(harness, '/progress-union/active', jsonReq('POST', '/progress-union/active', { sessionId: SESSION, active: true, source: 'command' }))
  return harness
}

function execUpdate(harness, args) {
  const tool = harness.toolMap.get('progress_update')
  return tool.definition.execute(args, { agent: harness.agent })
}

test('when 门控：默认不加载工具，启用后可见', async () => {
  const harness = createHarness()
  await harness.run()
  const tool = harness.toolMap.get('progress_update')
  assert.equal(tool.options.when({ agent: harness.agent }), false, '未启用时 when 必须为 false')
  await callRoute(harness, '/progress-union/active', jsonReq('POST', '/progress-union/active', { sessionId: SESSION, active: true, source: 'command' }))
  assert.equal(tool.options.when({ agent: harness.agent }), true)
})

test('新增/按 id 更新/删除：只回变化项与紧凑摘要', async () => {
  const harness = await booted()
  const added = await execUpdate(harness, {
    changes: [
      { title: '步骤一', status: 'doing', current: '正在做一', next: '二' },
      { title: '步骤二' },
    ],
  })
  assert.equal(added.ok, true)
  assert.equal(added.revision, 1)
  assert.equal(added.changed.length, 2)
  assert.deepEqual(added.summary, { total: 2, done: 0, doing: 1, todo: 1, blocked: 0, percent: 0 })

  const firstId = added.changed[0].id
  const edited = await execUpdate(harness, { changes: [{ id: firstId, status: 'done' }] })
  assert.equal(edited.revision, 2)
  assert.deepEqual(edited.changed[0].fields.sort(), ['percent', 'status'])
  assert.equal(edited.summary.done, 1)
  // done 强制 100%
  assert.equal(edited.summary.percent, 50)

  const removed = await execUpdate(harness, { changes: [{ id: firstId, remove: true }] })
  assert.equal(removed.changed[0].removed, true)
  assert.equal(removed.summary.total, 1)
})

test('按精确 title 更新；单命中正常、新增不误伤', async () => {
  const harness = await booted()
  await execUpdate(harness, { changes: [{ title: '唯一名' }] })
  const byTitle = await execUpdate(harness, { changes: [{ title: '唯一名', status: 'doing' }] })
  assert.equal(byTitle.changed[0].change, 'edit')
  const added = await execUpdate(harness, { changes: [{ title: '不存在的名' }] })
  assert.equal(added.changed[0].change, 'add')
})

test('历史重名数据歧义：按 title 更新报错要求 id', async () => {
  const mkItem = (id, order) => ({
    id, title: '重名', status: 'todo', percent: 0, current: '', next: '', approach: '', note: '',
    group: '', order, updatedAt: 1, updatedBy: 'user',
  })
  const key = Buffer.from(SESSION, 'utf8').toString('base64url')
  const harness = createHarness({
    seed: {
      [key]: {
        record: {
          version: 1, sessionId: SESSION, revision: 3, userRevision: 0, agentSeenRevision: 0,
          enabled: true, createdAt: 1, updatedAt: 1, items: [mkItem('p_a', 0), mkItem('p_b', 1)], userChanges: [],
        },
      },
    },
  })
  await harness.run()
  await assert.rejects(
    () => execUpdate(harness, { changes: [{ title: '重名', status: 'done' }] }),
    /对应多个任务/,
  )
})

test('批量全成全败：坏条目不得让前半批落盘', async () => {
  const harness = await booted()
  const before = await execUpdate(harness, { changes: [{ title: '已有任务' }] })
  await assert.rejects(
    () => execUpdate(harness, { changes: [{ title: '新增成功' }, { id: 'p_不存在', remove: true }] }),
    /找不到要删除的任务/,
  )
  const snapshot = harness.provided.get('progressAnchor').get(SESSION)
  assert.equal(snapshot.revision, before.revision, '失败批次不得推 revision')
  assert.equal(snapshot.board.summary.total, 1, '失败批次不得留下半应用条目')
})

test('409：expectedRevision 过期拒写并回快照', async () => {
  const harness = await booted()
  await execUpdate(harness, { changes: [{ title: 'A' }] })
  const res = await callRoute(
    harness,
    '/progress-union/action',
    jsonReq('POST', '/progress-union/action', { sessionId: SESSION, expectedRevision: 0, changes: [{ title: 'B' }] }),
  )
  assert.equal(res.status, 409)
  assert.match(res.json().error, /已被更新/)
})

test('ack 语义：用户改动未确认时 pending>0，ackUserRevision 后归零', async () => {
  const harness = await booted()
  const added = await execUpdate(harness, { changes: [{ title: '任务一' }] })
  const itemId = added.changed[0].id

  // 用户在面板改状态（origin=user 走 action 路由）
  const userRes = await callRoute(
    harness,
    '/progress-union/action',
    jsonReq('POST', '/progress-union/action', { sessionId: SESSION, changes: [{ id: itemId, status: 'blocked', note: '在等确认' }] }),
  )
  assert.equal(userRes.status, 200)
  const anchorAfterUserEdit = harness.provided.get('progressAnchor').get(SESSION)
  assert.equal(anchorAfterUserEdit.board.pendingUserChanges, 1)
  assert.equal(anchorAfterUserEdit.userEdits.length, 1)
  assert.equal(anchorAfterUserEdit.userEdits[0].kind, 'edit')

  // 注入面出现"用户改动"文本，且带 ackUserRevision 指引
  const userEditsText = harness.contexts.get('progress-union-user-edits')()
  assert.match(userEditsText, /progress-board-user-edits/)
  assert.match(userEditsText, new RegExp(`ackUserRevision=${anchorAfterUserEdit.revision}`))

  // agent 确认（changes=[] + ack），revision 不再增长
  const acked = await execUpdate(harness, { changes: [], ackUserRevision: anchorAfterUserEdit.revision })
  assert.equal(acked.revision, anchorAfterUserEdit.revision)
  const anchorAfterAck = harness.provided.get('progressAnchor').get(SESSION)
  assert.equal(anchorAfterAck.board.pendingUserChanges, 0)
  assert.equal(anchorAfterAck.userEdits.length, 0)
  assert.equal(harness.contexts.get('progress-union-user-edits')(), '')
})

test('ack 越界钳制：ackUserRevision 超过 userRevision 时被钳到 userRevision', async () => {
  const harness = await booted()
  const added = await execUpdate(harness, { changes: [{ title: '任务一' }] })
  const itemId = added.changed[0].id
  await callRoute(
    harness,
    '/progress-union/action',
    jsonReq('POST', '/progress-union/action', { sessionId: SESSION, changes: [{ id: itemId, note: 'x' }] }),
  )
  await execUpdate(harness, { changes: [], ackUserRevision: 999 })
  const anchor = harness.provided.get('progressAnchor').get(SESSION)
  assert.equal(anchor.board.pendingUserChanges, 0)
})

test('面板卸载不关掉工具；/progress off（command 源）才关', async () => {
  const harness = await booted()
  // panel 源的 active=false：不是用户决定，必须忽略
  await callRoute(harness, '/progress-union/active', jsonReq('POST', '/progress-union/active', { sessionId: SESSION, active: false, source: 'panel' }))
  assert.equal(harness.toolMap.get('progress_update').options.when({ agent: harness.agent }), true)
  // command 源的 off：真关
  const cmd = harness.commandMap.get('progress')
  cmd.handler({ agent: harness.agent, rawInput: 'off' })
  await flush()
  assert.equal(harness.toolMap.get('progress_update').options.when({ agent: harness.agent }), false)
  // 关板后三块投影全部静默（0 token 回归）
  assert.equal(harness.sections.get('progress-union-policy')(), '')
  assert.equal(harness.contexts.get('progress-union-kickoff')(), '')
  assert.equal(harness.contexts.get('progress-union-user-edits')(), '')
})

test('旧前缀别名 /progress-board/* 仍可用一版', async () => {
  const harness = await booted()
  const res = await callRoute(harness, '/progress-board/snapshot', { method: 'GET', url: `/progress-board/snapshot?sessionId=${SESSION}`, headers: {} })
  assert.equal(res.status, 200)
  assert.equal(res.json().enabled, true)
})
