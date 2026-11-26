/**
 * Phase 4 验收：client 契约守卫。
 * 1) 客户端文件不得残留 board 旧命名空间/旧 API 调用（fork 改造回归）；
 * 2) 客户端消费的两条路由形状（snapshot / status）由宿主实测钉住。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'union-test-'))
const { SESSION, createHarness, jsonReq, callRoute } = await import('./harness.mjs')

const clientFile = new URL('../client.js', import.meta.url).pathname.replace(/^\//, '')

test('client.js 命名空间已切到 union，无 progress-board API 残留', () => {
  const src = fs.readFileSync(clientFile, 'utf8')
  assert.match(src, /id: 'dsh-progress-union'/)
  assert.match(src, /const API = '\/progress-union'/)
  assert.match(src, /STATUS_API = '\/dsh-progress\/status'/)
  assert.doesNotMatch(src, /fetch\(`\/progress-board/, '不得残留旧 API 前缀的直接调用')
  assert.match(src, /useUnionTiming/, '迷你条时间面钩子必须在')
})

test('宿主 snapshot/status 两路由的客户端消费形状', async () => {
  const harness = createHarness()
  await harness.run()
  await callRoute(harness, '/progress-union/active', jsonReq('POST', '/progress-union/active', { sessionId: SESSION, active: true, source: 'command' }))
  await harness.toolMap.get('progress_update').definition.execute(
    { changes: [{ title: '渲染截图', status: 'doing', current: '渲染第 7/24 张' }, { title: '合成音轨' }] },
    { agent: harness.agent },
  )
  harness.emit('turn/start', {})
  harness.emit('step/start', {})

  const snap = (await callRoute(harness, '/progress-union/snapshot', { method: 'GET', url: `/progress-union/snapshot?sessionId=${SESSION}`, headers: {} })).json()
  assert.equal(snap.ok, true)
  assert.equal(snap.enabled, true)
  assert.deepEqual(snap.items.map((i) => i.title), ['渲染截图', '合成音轨'])
  assert.equal(typeof snap.summary.percent, 'number')
  assert.equal('pendingUserChanges' in snap, true)

  const status = (await callRoute(harness, '/dsh-progress/status', { method: 'GET', url: '/dsh-progress/status', headers: {} })).json()
  assert.equal(status.ok, true)
  assert.equal(status.config.pollMs, 1000)
  assert.ok(status.task, 'status.task 必须存在（迷你条数据源）')
  assert.equal(String(status.task.id), String(SESSION))
  // 板开：阶段直接取板 items，不再走关键词猜测
  assert.deepEqual(status.task.stages, ['渲染截图', '合成音轨'])
  assert.equal(status.task.boardDriven, true)
  assert.equal(status.task.current, 0)
  assert.ok(Array.isArray(status.tasks))
})
