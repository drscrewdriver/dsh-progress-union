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
  // 注意「全成全败」只针对**真语义错误**（remove 找不到目标、新增缺 title、percent
  // 非数字、歧义 title）。status 词表错已改为宽容跳过 + warnings（见下个用例）——
  // 那些是 PTC 通道绕过 schema 导致的输入噪声，不该让整批丢失。
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

test('PTC 容错：官方 todo 词表别名归一，不再整批抛错', async () => {
  const harness = await booted()
  // PTC 通道（run_code 内 tools.progress_update）绕过工具 JSON Schema，
  // 模型按官方 todo 词表传 pending / in_progress / completed。
  const added = await execUpdate(harness, {
    changes: [
      { title: '待办项', status: 'pending' },
      { title: '进行项', status: 'in_progress' },
      { title: '完成项', status: 'completed' },
    ],
  })
  assert.equal(added.ok, true, 'pending 不得再抛「未知状态」')
  assert.deepEqual(added.warnings, [], '合法别名不产生 warning')
  assert.deepEqual(added.summary, { total: 3, done: 1, doing: 1, todo: 1, blocked: 0, percent: 33 })
})

test('PTC 容错：无法识别的 status 跳过该字段并回 warning，同批其它条目照落', async () => {
  const harness = await booted()
  const added = await execUpdate(harness, {
    changes: [
      { title: '好条目', status: 'doing' },
      { title: '坏状态条目', status: '半吊子' },
    ],
  })
  assert.equal(added.ok, true, '坏词表不得让整批失败')
  assert.equal(added.warnings.length, 1)
  assert.match(added.warnings[0], /半吊子/)
  assert.match(added.warnings[0], /todo\|doing\|done\|blocked/)
  // 坏状态条目仍然建成功，只保留默认 status=todo
  const snap = harness.provided.get('progressAnchor').get(SESSION)
  assert.equal(snap.board.summary.total, 2)
  assert.equal(snap.board.summary.doing, 1)
  assert.equal(snap.board.summary.todo, 1)
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

test('PTC 内层工具进观察块：ptc-dispatch 不再只剩 run_code', async () => {
  const harness = await booted()
  await execUpdate(harness, { changes: [{ title: '做点事', status: 'doing' }] })
  // 外层只有 run_code（PTC 特征）
  harness.emit('tool/call', { name: 'run_code', arguments: '{"code":"tools.shell(1)"}' })
  // 内层真实工具在 ptc-dispatch 的终态事件上
  harness.emit('tool/ptc-dispatch', { name: 'shell', arguments: '{"command":"ls"}', isError: false })
  harness.emit('tool/ptc-dispatch', { name: 'read', arguments: '{"file_path":"a.js"}', isError: false })
  // dispatch-start 是起始事件，必须被忽略（否则同一条会记两次）
  harness.emit('tool/ptc-dispatch-start', { name: 'shell', arguments: '{"command":"ls"}' })
  const text = harness.contexts.get('progress-union-observer')()
  assert.match(text, /最近动作：.*shell/, 'PTC 内层 tool 必须出现在最近动作里')
  assert.match(text, /read/, '第二条内层 tool 也要在')
})

test('PTC 内层工具失败：观察块给出最近失败行', async () => {
  const harness = await booted()
  await execUpdate(harness, { changes: [{ title: '做点事', status: 'doing' }] })
  harness.emit('tool/ptc-dispatch', {
    name: 'glob',
    arguments: '{"pattern":"**/*"}',
    isError: true,
    content: [{ type: 'text', text: 'Error: tool call timed out after 30000ms' }],
  })
  const text = harness.contexts.get('progress-union-observer')()
  assert.match(text, /最近失败：glob/)
  assert.match(text, /timed out/)
})

test('旧前缀别名 /progress-board/* 仍可用一版', async () => {
  const harness = await booted()
  const res = await callRoute(harness, '/progress-board/snapshot', { method: 'GET', url: `/progress-board/snapshot?sessionId=${SESSION}`, headers: {} })
  assert.equal(res.status, 200)
  assert.equal(res.json().enabled, true)
})
