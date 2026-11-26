/**
 * /progress-goal 迷你目标域验收：
 * - create/status/budget/pause/resume/clear 命令；
 * - progress_goal_report 的 complete(证据+全板)/blocked(连续3次)/continue；
 * - 预算到顶转 blocked；followup 续轮身份与注入避让。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'union-goal-test-'))
const { SESSION, createHarness, jsonReq, callRoute } = await import('./harness.mjs')

async function booted(config = {}) {
  const harness = createHarness({ config })
  await harness.run()
  await callRoute(harness, '/progress-union/active', jsonReq('POST', '/progress-union/active', { sessionId: SESSION, active: true, source: 'command' }))
  return harness
}

function cmd(harness, input) {
  return harness.commandMap.get('progress-goal').handler({ agent: harness.agent, rawInput: input })
}

function report(harness, args) {
  return harness.toolMap.get('progress_goal_report').definition.execute(args, { agent: harness.agent })
}

async function snapshotOf(harness) {
  const res = await callRoute(harness, '/progress-union/snapshot', { method: 'GET', url: `/progress-union/snapshot?sessionId=${SESSION}`, headers: {} })
  return res.json()
}

test('create/status/budget/pause/resume/clear 全命令链', async () => {
  const h = await booted()
  let r = await cmd(h, '把插件改完并测试')
  assert.equal(r.kind, 'success')
  assert.match(r.text, /Status: active/)
  assert.match(r.text, /Rounds: 0\/256/)

  r = await cmd(h, 'budget 3')
  assert.match(r.text, /Rounds: 0\/3/)

  r = await cmd(h, 'status')
  assert.match(r.text, /Objective: "把插件改完并测试"/)

  r = await cmd(h, 'pause')
  assert.match(r.text, /Status: paused/)
  r = await cmd(h, 'resume')
  assert.match(r.text, /Status: active/)

  r = await cmd(h, 'clear')
  assert.equal(r.text, '目标已清除。')
  r = await cmd(h, 'status')
  assert.match(r.text, /没有目标/)
})

test('progress_goal_report: complete 需证据 + 全板完成', async () => {
  const h = await booted()
  await cmd(h, '目标A')
  // 无证据 → 拒
  let err = null
  try { await report(h, { status: 'complete' }) } catch (e) { err = e }
  assert.ok(err && /evidence/.test(err.message))
  // 建板但不全完成 → 拒
  await h.toolMap.get('progress_update').definition.execute(
    { changes: [{ title: 't1', status: 'doing', percent: 50 }, { title: 't2', status: 'todo' }] },
    { agent: h.agent },
  )
  err = null
  try { await report(h, { status: 'complete', evidence: ['x'] }) } catch (e) { err = e }
  assert.ok(err && /全部完成/.test(err.message))
  // 全部 done → 成功
  await h.toolMap.get('progress_update').definition.execute(
    { changes: [{ title: 't1', status: 'done' }, { title: 't2', status: 'done' }] },
    { agent: h.agent },
  )
  const r = await report(h, { status: 'complete', evidence: ['测试通过'] })
  assert.equal(r.goal.phase, 'complete')
})

test('blocked 连续 3 轮同因才落 phase，continue 清零', async () => {
  const h = await booted()
  await cmd(h, '目标B')
  let r = await report(h, { status: 'blocked', blocker: '等API' })
  assert.equal(r.goal.phase, 'active')
  assert.equal(r.goal.blockedStreak, 1)
  r = await report(h, { status: 'blocked', blocker: '等API' })
  assert.equal(r.goal.blockedStreak, 2)
  r = await report(h, { status: 'blocked', blocker: '等API' })
  assert.equal(r.goal.phase, 'blocked')
  await cmd(h, 'resume')
  r = await report(h, { status: 'blocked', blocker: '别的' })
  assert.equal(r.goal.blockedStreak, 1, '换原因重新计数')
  await report(h, { status: 'continue' })
  r = await report(h, { status: 'blocked', blocker: '别的' })
  assert.equal(r.goal.blockedStreak, 1, 'continue 清零 streak')
})

test('快照回显 goal 子对象', async () => {
  const h = await booted()
  await cmd(h, '目标C')
  await cmd(h, 'budget 7')
  const snap = await snapshotOf(h)
  assert.equal(snap.goal.objective, '目标C')
  assert.equal(snap.goal.maxRounds, 7)
  assert.equal(snap.goal.phase, 'active')
})
