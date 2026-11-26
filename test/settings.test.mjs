/**
 * 设置面契约守卫（2026-11-26 事故回归）。
 *
 * 1) 设置页字段表单靠 **schema 叶子** 的 `.volatile()` 标记生成：整对象标 volatile
 *    时一个字段都不渲染（客户端也就看不到任何可编辑项）。这里逐叶子断言标记存在。
 * 2) 客户端必须把设置卡注册到 `settings.section` 槽，并通过宿主 `configForms`
 *    句柄读写——否则「bundle 页 / 设置页」都没有配置入口。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'union-test-'))
const { Config } = await import('../index.js')

/** 递归收集点分键 → 是否带 volatile 标记。 */
function volatileLeaves(node, prefix = '', out = {}) {
  const inner = node && (node.dict || node.inner)
  if (!inner || typeof inner !== 'object') return out
  for (const [key, child] of Object.entries(inner)) {
    const dotted = prefix ? `${prefix}.${key}` : key
    const meta = (child && child.meta) || {}
    const nested = child && (child.dict || child.inner)
    if (nested && typeof nested === 'object') volatileLeaves(child, dotted, out)
    else out[dotted] = meta.volatile !== undefined
  }
  return out
}

test('Config：assistant / observer 的每个叶子都带 volatile（否则设置页不生成字段）', () => {
  const leaves = volatileLeaves(Config)
  const expected = [
    'protocolHint',
    'assistant.mode',
    'assistant.provider',
    'assistant.model',
    'assistant.baseUrl',
    'assistant.apiKey',
    'assistant.authority',
    'assistant.minIntervalMs',
    'assistant.autoApply',
    'observer.enabled',
    'observer.maxIdleSteps',
    'observer.maxIdleMs',
    'observer.autoSyncCurrent',
    'observer.autoSyncThrottleMs',
    'observer.maxItems',
    'todoSync',
    'todo.maxReconcileIntervalMs',
    'todo.mirrorThrottleMs',
  ]
  for (const key of expected) {
    assert.ok(key in leaves, `缺少配置键 ${key}`)
    assert.equal(leaves[key], true, `${key} 必须是叶子级 .volatile()`)
  }
})

test('Config：外层对象不得自己标 volatile（嵌套 volatile 会被宿主拒绝）', () => {
  for (const key of ['assistant', 'observer', 'todo']) {
    const node = (Config.dict || Config.inner || {})[key]
    assert.ok(node, `缺少 ${key} 节点`)
    assert.equal((node.meta || {}).volatile, undefined, `${key} 这层不能标 volatile`)
  }
})

test('客户端：设置卡双座位（settings.section + plugins.bundle.config）且走 configForms 句柄', () => {
  const file = new URL('../client.js', import.meta.url).pathname.replace(/^\//, '')
  const src = fs.readFileSync(file, 'utf8')
  assert.match(src, /registerSettingsSeat\('settings\.section'/, '必须注册 settings.section 槽')
  assert.match(src, /id: 'dsh-progress-union'/, '分节 id 必须固定')
  assert.match(src, /registerSettingsSeat\('plugins\.bundle\.config'/, 'bundle 详情页也要有配置卡（keyed by 包名）')
  assert.match(src, /key: 'dsh-progress-union'/, 'bundle 座位 key 必须是包名')
  assert.match(src, /configForms/, '必须经宿主 configForms 读写配置')
  assert.match(src, /function ProgressUnionSettings\(/, '设置卡组件必须在')
  assert.match(src, /scope\.subscribe/, '设置卡要订阅句柄快照')
  assert.match(src, /function ensureUnionSettingsStyle\(/, '样式要注入 document.head，否则设置页里裸奔')
})