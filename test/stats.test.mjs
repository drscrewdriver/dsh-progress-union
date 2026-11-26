/**
 * Should-Pass 验收：stats 学习链兼容——读鲸程（dsh-progress-task-bar）既有
 * `$DSH_HOME/dsh-progress-stats.json` 样本：不迁移、不改路径、不损坏原样本，
 * 新样本只在原数组尾部追加并按同一 schema 回写。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'union-stats-'))
process.env.DSH_HOME = HOME
const STATS = path.join(HOME, 'dsh-progress-stats.json')

// 鲸程原样写出的文件：s=第几步，r=当时离任务结束还剩几秒。
const LEGACY = Array.from({ length: 25 }, (_, i) => ({ s: 1, r: 60 + i * 10 }))
fs.writeFileSync(STATS, JSON.stringify({ version: 1, updatedAt: 1000, samples: LEGACY }))

const { SESSION, createHarness, jsonReq, callRoute, withClock } = await import('./harness.mjs')

test('既有样本被读取成本机学习档，且新样本追加回写不损坏原样本', async () => {
  const clock = withClock()
  try {
    const harness = createHarness()
    await harness.run()
    await callRoute(harness, '/progress-union/active', jsonReq('POST', '/progress-union/active', { sessionId: SESSION, active: true, source: 'command' }))

    harness.emit('turn/start', {})
    harness.emit('step/start', {})
    clock.advance(30000)

    // 25 条 s=1 样本 → bucket [1,2) 满 20 条，etaBasis 应从 'prior' 升到 'local'
    const learned = harness.provided.get('progressAnchor').get(SESSION)
    assert.equal(learned.time.etaBasis, 'local')
    assert.equal(learned.time.etaP75Min, 4) // p75 = 240s

    // 结束回合：产生一条真实样本 { s: 1, r: 30 }
    harness.emit('turn/end', {})

    const saved = JSON.parse(fs.readFileSync(STATS, 'utf8'))
    assert.equal(saved.version, 1, 'schema version 保持 1（未迁移）')
    assert.ok(saved.updatedAt > 1000, 'updatedAt 已刷新')
    assert.deepEqual(saved.samples.slice(0, LEGACY.length), LEGACY, '既有 25 条原样保留')
    assert.deepEqual(saved.samples.at(-1), { s: 1, r: 30 }, '新样本追加在尾部')
    assert.equal(saved.samples.length, LEGACY.length + 1)

    // 不迁移：DSH_HOME 里没有第二份 stats 文件
    const extra = fs.readdirSync(HOME).filter((f) => /progress.*stats/.test(f) && f !== path.basename(STATS))
    assert.deepEqual(extra, [], '没有生成迁移副本')
  } finally {
    clock.restore()
  }
})
