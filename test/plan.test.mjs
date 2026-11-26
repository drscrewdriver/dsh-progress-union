/**
 * v0.5.0 验收：plan 文档（codeplan 的 spec/tasks/checklist）解析 + 目录选择 + 零注入门。
 * - parseChecklistMarkdown：Phase 分组 / 两种勾选态 / t\d+ id / ✅ 证据尾 / 裸列表
 * - parseSpecOutline：H1–H3 骨架 + 首节行 + 上限
 * - planDirCandidates / pickPlanDir：mtime 最新、显式 slug 优先、目录没了不换别的
 * - sessionCwd：cwd 在 session **顶层**（实测），header 只作兼容兜底
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'union-plan-test-'))
const { SESSION, createHarness, jsonReq, callRoute, flush } = await import('./harness.mjs')
const { parseChecklistMarkdown, parseSpecOutline, normalizeStatus, planDirCandidates, pickPlanDir } =
  await import('../index.js')

async function bootedWithPlan({ config = {}, planBody = '## Phase 1: 做点事\n- [ ] t01 第一件事\n- [x] t02 第二件事\n' } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'union-plan-e2e-'))
  const dir = path.join(cwd, '.agents', 'plans', 'demo-plan')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'tasks.md'), planBody, 'utf8')
  fs.writeFileSync(path.join(dir, 'spec.md'), '# Spec: 演示\n\n## 需求\n- 让助手读计划\n', 'utf8')
  const harness = createHarness({ cwd, config })
  await harness.run()
  await callRoute(harness, '/progress-union/active', jsonReq('POST', '/progress-union/active', { sessionId: SESSION, active: true, source: 'command' }))
  return { harness, cwd }
}

function observerOf(harness) {
  return harness.contexts.get('progress-union-observer')()
}

test('端到端：plan 文档进观察块（planSync=read 默认）', async () => {
  const { harness } = await bootedWithPlan()
  // 观察块门控要求板上有活干
  await harness.toolMap.get('progress_update').definition.execute(
    { changes: [{ title: '做点事', status: 'doing' }] },
    { agent: harness.agent },
  )
  const text = observerOf(harness)
  assert.match(text, /\[plan\] demo-plan/, 'plan 行必须出现')
  assert.match(text, /勾选 1\/2/, '勾选计数来自 tasks.md')
  assert.match(text, /当前 Phase 1: 做点事/, '当前 Phase 取第一个含未勾项的 Phase')
})

test('端到端：planSync=off 时观察块零 plan 注入（0 token）', async () => {
  const { harness } = await bootedWithPlan({ config: { planSync: 'off' } })
  await harness.toolMap.get('progress_update').definition.execute(
    { changes: [{ title: '做点事', status: 'doing' }] },
    { agent: harness.agent },
  )
  const text = observerOf(harness)
  assert.doesNotMatch(text, /\[plan\]/, 'off 时不得出现 plan 行')
})

test('端到端：cwd 拿不到（无 session.cwd）时静默不注入，不抛错', async () => {
  const harness = createHarness() // 不给 cwd
  await harness.run()
  await callRoute(harness, '/progress-union/active', jsonReq('POST', '/progress-union/active', { sessionId: SESSION, active: true, source: 'command' }))
  await harness.toolMap.get('progress_update').definition.execute(
    { changes: [{ title: '做点事', status: 'doing' }] },
    { agent: harness.agent },
  )
  assert.doesNotMatch(observerOf(harness), /\[plan\]/)
})

test('/progress plan <slug>：绑定不存在的 slug 报错并列出候选', async () => {
  const { harness } = await bootedWithPlan()
  const cmd = harness.commandMap.get('progress')
  const bad = cmd.handler({ agent: harness.agent, rawInput: 'plan ghost-plan' })
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /找不到计划/)
  assert.match(bad.text, /demo-plan/, '报错要列出可用候选')

  const ok = cmd.handler({ agent: harness.agent, rawInput: 'plan demo-plan' })
  assert.equal(ok.kind, 'success')
  const off = cmd.handler({ agent: harness.agent, rawInput: 'plan off' })
  assert.equal(off.kind, 'success')
  assert.match(off.text, /已解绑/)
})

test('助手输入带 <plan> 段（planBrief 是任务细化原料）', async () => {
  // 助手输入与观察块共用同一个 scanPlan：这里用 direct 助手通道截获真实请求体，
  // 断言 <plan> 段确实进了 user 消息（不是只进观察块）。
  const { harness, cwd } = await bootedWithPlan({
    config: { assistant: { mode: 'direct', baseUrl: 'http://x/v1', model: 'm', authority: 'slots', minIntervalMs: 0, autoApply: true } },
  })
  await harness.toolMap.get('progress_update').definition.execute(
    { changes: [{ title: '做点事', status: 'doing' }] },
    { agent: harness.agent },
  )
  const seen = []
  const original = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    seen.push(String(init && init.body || ''))
    return { ok: true, status: 200, async json() { return { choices: [{ message: { content: '{"board":{"changes":[]},"round":{"status":"continue"},"note":"ok"}' } }] } } }
  }
  try {
    // 模型久未同步：推进若干步让 maybeAskAssistant 触发
    let now = Date.now()
    for (let i = 0; i < 7; i += 1) {
      now += 200000 // 越过 maxIdleMs
      harness.emit('step/start', {})
    }
    await new Promise((r) => setTimeout(r, 120))
    await flush()
    const joined = seen.join('\n')
    assert.ok(seen.length > 0, `助手应被调用至少一次（实得 ${seen.length}）；cwd=${cwd}`)
    // 注意 body 是 JSON 字符串，引号已转义 → 用 includes 而不是正则
    assert.ok(joined.includes('<plan slug=\\"demo-plan\\"'), '助手输入必须带 plan 段')
    assert.ok(joined.includes('勾选：1/2'), '勾选计数来自 tasks.md')
    assert.ok(joined.includes('Phase 1: 做点事 1/2'), '各 Phase 进度也要在')
    assert.ok(joined.includes('未完：t01'), '未完项带任务 id')
    assert.ok(joined.includes('spec 大纲'), 'spec 大纲也要在')
    assert.ok(joined.includes('</plan>'), '段闭合')
  } finally {
    globalThis.fetch = original
  }
})


test('parseChecklistMarkdown：Phase 分组 + 两态勾选 + id 提取', () => {
  const md = [
    '# Tasks',
    '',
    '> 勾选点位约定：`- [ ]`→`- [x]`',
    '',
    '## Phase 1: 基础设施',
    '- [ ] t01 搭建项目结构',
    '- [x] t02 配置依赖',
    '',
    '## Phase 2: 核心实现',
    '- [ ] t03 实现核心逻辑',
  ].join('\n')
  const r = parseChecklistMarkdown(md)
  assert.deepEqual(r.counts, { total: 3, done: 1, pending: 2 })
  const phases = r.phases.filter((p) => p.title)
  assert.deepEqual(phases.map((p) => p.title), ['Phase 1: 基础设施', 'Phase 2: 核心实现'])
  assert.equal(phases[0].tasks.length, 2)
  assert.equal(phases[0].tasks[0].id, 't01')
  assert.equal(phases[0].tasks[0].text, '搭建项目结构')
  assert.equal(phases[0].tasks[0].checked, false)
  assert.equal(phases[0].tasks[1].checked, true)
  assert.equal(phases[1].tasks[0].id, 't03')
})

test('parseChecklistMarkdown：✅ 证据尾只在勾选态剥离；未勾选保留原文', () => {
  const md = [
    '## Must Pass',
    '- [x] 核心功能测试 ✅ test 12/12 pass（2026-11-26）',
    '- [ ] 边界条件处理 ✅ 这不该被当证据',
  ].join('\n')
  const r = parseChecklistMarkdown(md)
  const [done, pending] = r.phases[0].tasks
  assert.equal(done.text, '核心功能测试')
  assert.match(done.evidence, /test 12\/12 pass/)
  // 未勾选：不剥尾，整行当正文（否则会误删正文里的 ✅）
  assert.match(pending.text, /这不该被当证据/)
  assert.equal(pending.evidence, '')
})

test('parseChecklistMarkdown：无标题裸列表落 phase=""；`* [X]` 与大小写容错', () => {
  const md = ['- [X] 大写勾', '* [ ] 星号项'].join('\n')
  const r = parseChecklistMarkdown(md)
  assert.equal(r.phases.length, 1)
  assert.equal(r.phases[0].title, '')
  assert.equal(r.counts.total, 2)
  assert.equal(r.counts.done, 1)
  assert.equal(r.phases[0].tasks[1].text, '星号项')
})

test('parseChecklistMarkdown：空/坏输入不抛错', () => {
  for (const input of ['', null, undefined, 'no lists here']) {
    const r = parseChecklistMarkdown(input)
    assert.deepEqual(r.counts, { total: 0, done: 0, pending: 0 })
  }
})

test('parseSpecOutline：H1–H3 骨架 + 每节首行', () => {
  const md = [
    '# Spec: 某事',
    '',
    '## 需求',
    '- [功能需求列表]',
    '',
    '## 技术方案',
    '| 模块 | 改动 |',
    '## 约束',
    '- 不新增依赖',
  ].join('\n')
  const out = parseSpecOutline(md)
  assert.deepEqual(out.map((s) => s.title), ['Spec: 某事', '需求', '技术方案', '约束'])
  assert.equal(out[1].first, '- [功能需求列表]')
  // 表格行不当首行摘要
  assert.equal(out[2].first, '')
  assert.equal(out[3].first, '- 不新增依赖')
})

test('normalizeStatus：官方 todo 词表与常见写法都归一', () => {
  const cases = {
    pending: 'todo', 'not-started': 'todo', open: 'todo',
    in_progress: 'doing', 'in-progress': 'doing', running: 'doing', WIP: 'doing',
    completed: 'done', complete: 'done', FINISHED: 'done',
    waiting: 'blocked', failed: 'blocked', stuck: 'blocked',
    '  doing  ': 'doing',
  }
  for (const [raw, want] of Object.entries(cases)) assert.equal(normalizeStatus(raw), want, raw)
  // 不认识 / 非字符串：undefined（由调用方决定宽容或抛错）
  for (const raw of ['半吊子', '', null, undefined, 42]) assert.equal(normalizeStatus(raw), undefined, String(raw))
})

function mkPlan(cwd, slug, files) {
  const dir = path.join(cwd, '.agents', 'plans', slug)
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body, 'utf8')
  return dir
}

test('planDirCandidates / pickPlanDir：mtime 最新优先；无任务文件的目录被跳过', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'union-plan-dir-'))
  const older = mkPlan(cwd, 'old-plan', { 'tasks.md': '## A\n- [ ] t01 x\n' })
  const newer = mkPlan(cwd, 'new-plan', { 'tasks.md': '## B\n- [ ] t02 y\n' })
  // 造一个只有 spec.md 的目录：应被跳过（没有勾选表可喂）
  mkPlan(cwd, 'spec-only', { 'spec.md': '# Spec\n## 需求\n' })
  const past = Date.now() - 3600 * 1000
  fs.utimesSync(path.join(older, 'tasks.md'), new Date(past), new Date(past))
  const list = planDirCandidates(cwd)
  assert.deepEqual(list.map((x) => x.slug), ['new-plan', 'old-plan'])
  assert.equal(pickPlanDir(cwd).slug, 'new-plan')
  assert.equal(pickPlanDir(cwd, 'old-plan').slug, 'old-plan')
  // 显式绑了一个不存在的 slug：返回 null，不悄悄换成别的计划
  assert.equal(pickPlanDir(cwd, 'ghost-plan'), null)
  // cwd 为空/不存在：null，不抛
  assert.equal(pickPlanDir(''), null)
  assert.equal(pickPlanDir(path.join(cwd, 'nope')), null)
  void newer
})

test('sync 回勾：板项 done 且正文命中 → tasks.md 从 [ ] 变 [x] 并追加 ✅ 证据', async () => {
  const { harness } = await bootedWithPlan({ config: { planSync: 'sync' } })
  // 板项标题必须在 tasks.md 正文里出现，才会被回勾（不猜 id）
  await harness.toolMap.get('progress_update').definition.execute(
    { changes: [{ title: '第一件事', status: 'done', current: '跑通了 12/12' }] },
    { agent: harness.agent },
  )
  const file = path.join(harness.agent.session.cwd, '.agents', 'plans', 'demo-plan', 'tasks.md')
  const after = fs.readFileSync(file, 'utf8')
  assert.match(after, /- \[x\] t01 第一件事 ✅（验证：跑通了 12\/12；\d{4}-\d{2}-\d{2}）/, '应回勾并追加证据')
  assert.match(after, /\n- \[x\] t02 第二件事/, '原有的勾选保持不变')
})

test('sync 回勾护栏：标题不匹配 / 已勾选的行绝不动', async () => {
  const body = '## Phase 1\n- [ ] t01 完全无关的任务\n- [x] t02 已勾选的任务\n'
  const { harness } = await bootedWithPlan({ config: { planSync: 'sync' }, planBody: body })
  await harness.toolMap.get('progress_update').definition.execute(
    { changes: [{ title: '板里另起一条', status: 'done' }] },
    { agent: harness.agent },
  )
  const file = path.join(harness.agent.session.cwd, '.agents', 'plans', 'demo-plan', 'tasks.md')
  assert.equal(fs.readFileSync(file, 'utf8'), body, '不命中就不写文件，一个字节都不改')
})

test('read 模式（默认）绝不写 tasks.md', async () => {
  const body = '## Phase 1\n- [ ] t01 第一件事\n'
  const { harness } = await bootedWithPlan({ planBody: body })
  await harness.toolMap.get('progress_update').definition.execute(
    { changes: [{ title: '第一件事', status: 'done' }] },
    { agent: harness.agent },
  )
  const file = path.join(harness.agent.session.cwd, '.agents', 'plans', 'demo-plan', 'tasks.md')
  assert.equal(fs.readFileSync(file, 'utf8'), body, '默认 read 模式不得写用户文件')
})
