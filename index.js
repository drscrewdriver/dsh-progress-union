/**
 * dsh-progress-union — host half.
 *
 * 结合原型：
 *  - 槽位真相源 fork 自 l3j3y3/dsh-progress-board (MIT)：per-session 扁平任务板、
 *    revision 补丁 API、`progress_update` 增量工具、policy/user-edits/kickoff 三块
 *    每请求重建的投影注入。
 *  - 时间/ETA 引擎 fork 自 uuhihj/task-progress-bar dsh-progress-widget (MIT)：
 *    事件驱动 (turn/step/todo/subagent) 的步数与耗时统计、ETA 先验 + 本机学习、
 *    `$DSH_HOME/dsh-progress-stats.json` 样本沿用不迁移。
 *  - 新增 progressAnchor 只读锚点平面：board(语义) / time(时间) / userEdits(未确认
 *    用户改动) 三层，service + HTTP 双平面同一 builder，供压缩插件在压缩前取用。
 *    契约见 README「给压缩插件的锚点契约」。
 *
 * 单协议收敛：board 启用的会话不再注入鲸程的文件上报协议（progress_update 是唯一
 * 写通道）；板关闭时文件上报层与 /dsh-progress/status 兼容原样保留。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'

// 设置页可见性：0.1.7+ 宿主把 composition entry 当设置节，直接按导出的 Config
// **逐叶子**的 .volatile() 标记生成「设置 → 插件」里的表单，并把 volatile 字段以
// live ref（带 .get()）注入 apply。整对象套一层 .volatile() 不生成字段表单（面板
// 只会空空如也），所以必须每个叶子单独标——与 dsh-llm-openai-completions 同式。
export const Config = z.object({
  protocolHint: z.boolean().default(true).volatile(),
  assistant: z.object({
    mode: z.union(['', 'registered', 'direct']).default('').volatile(),
    provider: z.string().default('').volatile(),
    model: z.string().default('').volatile(),
    baseUrl: z.string().default('').volatile(),
    apiKey: z.string().role('secret').default('').volatile(),
    authority: z.union(['slots', 'rounds', 'both']).default('both').volatile(),
    minIntervalMs: z.number().step(1000).min(0).default(90000).volatile(),
    autoApply: z.boolean().default(true).volatile(),
  }).default({}),
  observer: z.object({
    enabled: z.boolean().default(true).volatile(),
    maxIdleSteps: z.number().step(1).min(1).default(6).volatile(),
    maxIdleMs: z.number().step(1000).min(1000).default(180000).volatile(),
    autoSyncCurrent: z.boolean().default(true).volatile(),
    autoSyncThrottleMs: z.number().step(1000).min(0).default(60000).volatile(),
    maxItems: z.number().step(1).min(1).default(12).volatile(),
  }).default({}),
  todoSync: z.union(['off', 'mirror', 'reconcile']).default('reconcile').volatile(),
  todo: z.object({
    maxReconcileIntervalMs: z.number().step(1000).min(0).default(60000).volatile(),
    mirrorThrottleMs: z.number().step(1).min(0).default(200).volatile(),
  }).default({}),
})

// —— 路由与存储标识 ——
const ROUTE_BASE = '/progress-union'
const LEGACY_BASE = '/progress-board' // 别名保留一版，与 board 原面板/脚本兼容
const WIDGET_STATUS_ROUTE = '/dsh-progress/status'
const UNIT_NAME = 'progress_union'
const ANCHOR_VERSION = 1

// —— board 侧限额（fork 原值，不放宽）——
const MAX_BODY_BYTES = 256 * 1024
const MAX_ITEMS = 200
const MAX_CHANGES = 50
const MAX_USER_CHANGES = 80
const MAX_TITLE = 180
const MAX_TEXT = 600
const MAX_APPROACH = 2000
const MAX_NOTE = 1600
const MAX_GROUP = 80
const STALE_MS = 10 * 60 * 1000
const KICKOFF_COOLDOWN_MS = 60 * 1000
const STATUSES = new Set(['todo', 'doing', 'done', 'blocked'])

// —— /progress-goal 迷你目标域常量（自建，不复用官方 goals 域）——
const GOAL_PHASES = new Set(['idle', 'active', 'paused', 'blocked', 'complete'])
const GOAL_SOURCE_KIND = 'plugin:progress-goal-goal' // producer-owned source kind（身份栅栏用）
const GOAL_DEFAULT_MAX_ROUNDS = 256
const GOAL_BLOCK_STREAK = 3 // blocked 连续 N 轮同一条件才落 phase（对齐 tool-goal 默认）
const GOAL_TAG = '<progress_goal_round>'

// —— widget 侧时间与统计（DSH_HOME 与鲸程共文件，样本不迁移）——
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PROGRESS_FILE = path.join(DSH_HOME, 'dsh-progress.json')
const PROGRESS_DIR = path.join(DSH_HOME, 'dsh-progress')
const PROGRESS_DIR_KEEP_MS = 24 * 60 * 60 * 1000
const STATS_FILE = path.join(DSH_HOME, 'dsh-progress-stats.json')
const STATS_MAX = 400
const IDLE_END_MS = 10 * 60 * 1000 // 兜底：turn 打开但 10 分钟无活动视为卡死结束
const FILE_STALE_MS = 2 * 60 * 1000 // 上报/板数据 2 分钟未更新视为陈旧
const SWEEP_MS = 4000
const BAD_READ_GRACE_MS = 2000

export const name = 'dsh-progress-union'
export const inject = ['tools', 'systemPrompt', 'webServer', 'agents', 'commands', 'llm', 'settings']

const PROGRESS_POLICY = `## 进度板
progress_update 维护用户可见的实时进度板。每项含 title/status/percent/current/next/approach/note。
- 每个用户回合开始时先检查进度板：如果板是空的，你的第一个工具调用必须是 progress_update，先建立扁平任务，再执行任何其他工具。不要等做完才补计划。
- 每个用户回合至少调用一次 progress_update：这条消息是新任务就先增补任务（第一项设为 doing），不是新任务就传 changes=[] 确认。上一轮的任务已全部完成时同样要这样做，不要整回合都不碰进度板。
- 准备开始一项任务时先把该项设为 doing，current 写正在准备/做什么；完成时立即设为 done；若还有下一步，把下一条设为 doing。除每回合的确认调用外，只在完成任务、状态/百分比实质变化、思路转向或应用用户改动时更新；只发变化项，不重发整份计划。
- 用户每发来一段新的需求或反馈，先判断是否新任务；若是，在该回合开头新增/调整任务，再动手。
- 用户改动会以“进度板用户改动”注入，只含变化字段；以它为准，处理完传 ackUserRevision。
- 聊天只说明推进、下一步和待决策点，不复述整份计划。

## 提问
禁止猜。只有三类立即停：不可逆/高后果；目标根本歧义且在前 10%；需要价值判断或策略取舍。
其余采用可逆默认并标注假设；只有答案会显著改变路径、且至少两个维度各有三种合理解读时才问。
输入/约束澄清最晚约 50%，任何澄清不拖到中后段。每任务最多 2 轮、每轮最多 3 问；选项化、给推荐默认、先复述理解。问前把相关任务标 blocked 并写清等什么。`

// 辅助 LLM（审查/监视 + 槽位管理 + 轮次草案）的 system prompt。
// 事实进输入、判断不进输入：助手可改槽位/产轮次草案，但判断权归主模型。
const ASSISTANT_SYSTEM = 'You are a progress assistant for a task board in a long-running goal session. ' +
  'Given the board checklist and recent assistant output / tool activity / file changes, produce two things: ' +
  '(1) board slot changes that make the board match reality (you MAY add, edit, or remove items); ' +
  '(2) a ROUND suggestion stating whether work should continue, is complete, or is blocked, with evidence. ' +
  'Your round suggestion is ADVICE only — the main model decides; never claim the goal is done yourself. ' +
  'Output strictly ONE JSON object with this shape: ' +
  '{"board":{"changes":[{"id":"<existing id for edit/remove, omit for add>","kind":"add|edit|remove","title"?:string,"status"?:"todo|doing|done|blocked","percent"?:0-100,"current"?:string,"next"?:string,"note"?:string}]},' +
  '"round":{"status":"continue|complete|blocked","summary":string,"evidence":string[],"nextSteps":string[],"blocker":string},"note":"<one line verdict>"}. ' +
  'Use "add" with a title to create items; "edit" with an id to update; "remove" with an id to delete. ' +
  'For "complete" you MUST list concrete evidence and the board should already be all done. ' +
  'For "blocked" you MUST give a concrete blocker string. ' +
  'Emit at most 8 changes. If nothing needs changing, use {"board":{"changes":[]},"round":{...},"note":"..."}. ' +
  'Respond with the JSON object only — no prose, no code fences.'

// v0.3.0 todo 裁决 system：只做差异裁决，不改写事实；输出严格三选一。
const TODO_RECONCILE_SYSTEM = 'You reconcile a task board with an external official todo list. ' +
  'The board is the user-facing source of truth; the todo list is the model work list. ' +
  'Given both lists plus recent assistant output/tool activity, decide ONE resolution: ' +
  '"adopt-todo" (todo is newer/correct, replace board), "keep-board" (board is correct, re-mirror it), ' +
  'or "merge" (apply incremental board.changes without dropping board facts). ' +
  'Output strictly ONE JSON object: ' +
  '{"resolution":"adopt-todo|keep-board|merge","board":{"changes":[{"id"?:string,"kind"?:string,"title"?:string,"status"?:string}]},"todo":{"todos"?:[]},"note":"<one line>"}. ' +
  'For "merge", board.changes must use the same shape as the board assistant changes. ' +
  'Emit at most 8 changes. Respond with the JSON object only — no prose, no code fences.'

// ============================================================================
// 通用工具（board fork）
// ============================================================================

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function text(value, max) {
  if (typeof value !== 'string') return undefined
  return value.trim().slice(0, max)
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function sessionKey(sessionId) {
  return Buffer.from(sessionId, 'utf8').toString('base64url')
}

function emptyState(sessionId) {
  const now = Date.now()
  return {
    version: 1,
    sessionId,
    revision: 0,
    userRevision: 0,
    agentSeenRevision: 0,
    enabled: false,
    createdAt: now,
    updatedAt: now,
    items: [],
    userChanges: [],
    todoMirror: null, // v0.3.0：自家镜像写入的 hash/at/count，回环识别用
    goal: emptyGoal(),
  }
}

function newGoalId() {
  return `goal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function emptyGoal() {
  return {
    id: newGoalId(),
    objective: '',
    phase: 'idle',
    maxRounds: GOAL_DEFAULT_MAX_ROUNDS,
    roundsStarted: 0,
    blockedStreak: 0,
    blockedReason: null,
    activation: 'disarmed',
    currentRound: 0, // 正在派发的轮次（attempt），0 表示无
  }
}

function newItemId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function summarize(items) {
  const total = items.length
  const counts = { done: 0, doing: 0, todo: 0, blocked: 0 }
  let sum = 0
  for (const item of items) {
    counts[item.status] += 1
    sum += item.percent
  }
  return {
    total,
    done: counts.done,
    doing: counts.doing,
    todo: counts.todo,
    blocked: counts.blocked,
    percent: total === 0 ? 0 : Math.round(sum / total),
  }
}

// —— v0.3.0：板 → 官方 todo 的纯映射（content 唯一非空、in_progress ≤1）——
function boardToTodos(state, maxItems) {
  const limit = Math.max(1, Number(maxItems) || 12)
  const items = (Array.isArray(state && state.items) ? state.items : [])
    .slice()
    .sort((a, b) => a.order - b.order || a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
    .slice(0, limit)
  const todos = []
  const seen = new Set()
  let doingSeen = false
  for (const item of items) {
    const content = String(item && item.title || '').trim()
    if (!content || seen.has(content)) continue
    seen.add(content)
    let status = 'pending'
    if (item.status === 'done') status = 'completed'
    else if (item.status === 'doing') {
      if (!doingSeen) { status = 'in_progress'; doingSeen = true }
    }
    todos.push({ content, status })
  }
  return todos
}

// 稳定内容哈希（顺序敏感）：同一批 todos 同值，顺序变化不同值。
function hashTodos(todos) {
  const stable = JSON.stringify((Array.isArray(todos) ? todos : []).map((t) => [String(t && t.content || ''), String(t && t.status || '')]))
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < stable.length; i += 1) {
    const c = stable.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0
    h2 = Math.imul(h2 + c + i, 2246822519) >>> 0
  }
  return h1.toString(36) + h2.toString(36)
}

function todoMirrorOf(state) {
  const m = state && state.todoMirror
  if (!isObject(m)) return null
  return {
    hash: typeof m.hash === 'string' ? m.hash : '',
    at: finiteNumber(m.at) ?? 0,
    count: finiteNumber(m.count) ?? 0,
    unsupported: m.unsupported === true,
  }
}

function normalizeItems(items) {
  items.sort((a, b) => a.order - b.order || a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
  items.forEach((item, index) => {
    item.order = index
  })
}

function itemView(item) {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    percent: item.percent,
    current: item.current,
    next: item.next,
    approach: item.approach || '',
    note: item.note,
    group: item.group,
    order: item.order,
    updatedAt: item.updatedAt,
    updatedBy: item.updatedBy,
  }
}

function compactValue(value) {
  if (value === undefined) return null
  if (typeof value === 'string' && value.length > 240) return `${value.slice(0, 240)}…`
  return value
}

function fieldLabel(field) {
  return (
    {
      title: '标题',
      status: '状态',
      percent: '百分比',
      current: '当前动作',
      next: '下一步',
      approach: '思路与实现',
      note: '备注',
      group: '分组',
      order: '顺序',
    }[field] || field
  )
}

function describeChange(change) {
  if (change.kind === 'add') {
    const details = (change.fields || [])
      .filter((field) => field.field !== 'order')
      .map((field) => `${fieldLabel(field.field)}=${JSON.stringify(compactValue(field.to))}`)
      .join('，')
    return `- [${change.itemId}] 新增任务「${change.title}」${details ? `（${details}）` : ''}`
  }
  if (change.kind === 'remove') {
    return `- [${change.itemId}] 删除任务「${change.title}」`
  }
  const fields = (change.fields || [])
    .filter((field) => field.field !== 'order')
    .map(
      (field) =>
        `${fieldLabel(field.field)}：${JSON.stringify(compactValue(field.from))} → ${JSON.stringify(compactValue(field.to))}`,
    )
    .join('；')
  return `- [${change.itemId}] 「${change.title}」${fields ? `：${fields}` : ''}`
}

// ============================================================================
// 时间引擎工具（widget fork；仅 board 关闭的回落路径才用关键词猜测）
// ============================================================================

function readJsonText(file) {
  // 去 BOM：PowerShell 5.1 写出的 efbbbf 会让 JSON.parse 直接抛——表现为"文件明明在读不到"。
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
}

const lastGoodByKey = new Map()
let lastGoodAt = 0

function parseProgressFile(file, key) {
  try {
    const parsed = JSON.parse(readJsonText(file))
    if (parsed && typeof parsed === 'object' && typeof parsed.task === 'string' && Array.isArray(parsed.stages)) {
      lastGoodByKey.set(key, parsed)
      lastGoodAt = Date.now()
      return parsed
    }
  } catch (err) {
    // 只在"文件存在但读坏了"时兜底；文件被删要立刻消失（与鲸程行为一致）
    if (err && err.code !== 'ENOENT') {
      const prev = lastGoodByKey.get(key)
      if (prev && Date.now() - lastGoodAt < BAD_READ_GRACE_MS) return prev
    }
    lastGoodByKey.delete(key)
  }
  return null
}

// 鲸程兼容层：读 $DSH_HOME/dsh-progress/<sid>.json 上报（板关闭时的增强层）。
function readFileTasks() {
  const out = []
  let names = []
  try {
    names = fs.readdirSync(PROGRESS_DIR).filter((n) => n.endsWith('.json'))
  } catch (_err) {
    names = []
  }
  for (const name of names) {
    const full = path.join(PROGRESS_DIR, name)
    const parsed = parseProgressFile(full, full)
    if (parsed) out.push({ ...parsed, reportId: parsed.session ? String(parsed.session) : name.replace(/\.json$/, ''), source: 'dir' })
  }
  // 24 小时未更新的分文件顺手清理（活跃会话个位数，逐次 stat 可忽略）
  for (const name of names) {
    const full = path.join(PROGRESS_DIR, name)
    try {
      const st = fs.statSync(full)
      if (Date.now() - st.mtimeMs > PROGRESS_DIR_KEEP_MS) {
        fs.unlinkSync(full)
        lastGoodByKey.delete(full)
      }
    } catch (_err) {}
  }
  const legacy = parseProgressFile(PROGRESS_FILE, PROGRESS_FILE)
  if (legacy) out.push({ ...legacy, reportId: legacy.session ? String(legacy.session) : 'legacy', source: 'legacy' })
  return out
}

function textOf(msg) {
  try {
    if (!msg) return ''
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join(' ')
        .trim()
    }
    if (typeof msg.content === 'string') return msg.content.trim()
    return ''
  } catch (_err) {
    return ''
  }
}

const TITLE_MAP = [
  [/修|bug|报错|错误|不行|失败|坏了|出问题|异常|打不开/, '问题修复'],
  [/开发|实现|做|写|加一个|新增|功能|插件|脚本|搭|改|修改|优化|完善/, '功能开发'],
  [/为什么|原因|分析|查|排查|看看|看一下/, '问题分析'],
  [/整理|分类|移动|清理|重命名|归档|归纳/, '文件整理'],
  [/安装|部署|配置|接入/, '安装部署'],
  [/测试|验证|检查|试用/, '测试验证'],
  [/总结|回顾|复盘/, '总结'],
  [/方案|建议|怎么办|怎么弄|如何|怎么处理|给点/, '方案咨询'],
  [/\b(fix|bug|error|broken|crash|fail(ed|ure)?)\b/i, '问题修复'],
  [/\b(implement|add|build|create|feature|write|refactor)\b/i, '功能开发'],
  [/\b(why|analy[sz]e|investigate|check|debug|look into|figure out)\b/i, '问题分析'],
  [/\b(clean|organi[sz]e|sort|move|rename|archive)\b/i, '文件整理'],
  [/\b(install|deploy|setup|configure|migrate)\b/i, '安装部署'],
  [/\b(test|verify|validate|smoke)\b/i, '测试验证'],
  [/\b(summary|summari[sz]e|retro|retrospective|review)\b/i, '总结'],
  [/\b(plan|proposal|approach|options|how (do|to))\b/i, '方案咨询'],
]

function summarizeTitle(text) {
  const raw = String(text || '').trim()
  if (!raw) return '新任务'
  for (const [re, label] of TITLE_MAP) {
    if (re.test(raw)) return label
  }
  let t = raw
  t = t.replace(/^(请你帮我|请你|帮我|麻烦你|麻烦|请|帮我一下|帮忙|能不能|可不可以|你给我|你帮我|你来|给我|你觉得|你怎么|你告诉我|那你|那你觉得|我想|我要)/, '')
  t = t.replace(/[。！!？?\s,，]+$/, '')
  t = t.trim()
  if (!t) return '新任务'
  const stop = t.search(/[。！!？?]/)
  if (stop > 0) t = t.slice(0, stop)
  if (t.length > 20) {
    if (/^[\x20-\x7E]*$/.test(t)) {
      const cut = t.slice(0, 20)
      const sp = cut.lastIndexOf(' ')
      t = (sp > 8 ? cut.slice(0, sp) : cut).trim() + '…'
    } else {
      t = t.slice(0, 20) + '…'
    }
  }
  return t
}

// 子智能体任务名不走 TITLE_MAP 归类（否则全叫"问题修复"分不清谁是谁），优先派发 label。
function summarizeSubTitle(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim()
  if (!raw) return '子任务'
  let t = raw.replace(/^(请你帮我|请你|帮我|麻烦你|麻烦|请|帮我一下|帮忙|能不能|可不可以|你给我|你帮我|你来|给我)/, '').trim()
  const stop = t.search(/[。！!？?\n]/)
  if (stop > 0) t = t.slice(0, stop)
  if (t.length > 24) t = t.slice(0, 24) + '…'
  return t || '子任务'
}

// 自动阶段模板：仅 board 关闭时兜底显示（标注"自动估计"），锚点不吃这条。
function guessStages(text) {
  const t = String(text || '')
  if (/修|bug|报错|错误|不行|失败|异常|打不开/.test(t)) return ['定位问题', '实施修复', '验证结果']
  if (/开发|实现|功能|插件|脚本|新增|搭建/.test(t)) return ['实现', '验证', '收尾']
  if (/为什么|原因|分析|排查|查|看看/.test(t)) return ['收集信息', '分析原因', '给出结论']
  if (/整理|分类|清理|移动|归档|归纳/.test(t)) return ['盘点现状', '分类处理', '校验交付']
  if (/方案|建议|怎么办|怎么弄|如何/.test(t)) return ['分析需求', '拟定方案', '交付方案']
  if (/安装|部署|配置|接入/.test(t)) return ['准备', '执行安装', '验证生效']
  return ['处理中', '收尾']
}

// 内置先验：1481 个真实 turn 实测，"跑到第 N 步时之后通常还要多久（秒）"。
const ETA_PRIOR = [
  [1, 2, 66, 234],
  [2, 3, 55, 240],
  [3, 5, 60, 300],
  [5, 10, 72, 294],
  [10, 16, 66, 306],
  [16, 26, 138, 618],
  [26, Infinity, 186, 618],
]

function priorFor(step) {
  const s = Math.max(1, Math.floor(Number(step) || 1))
  for (const r of ETA_PRIOR) if (s >= r[0] && s < r[1]) return { p50: r[2], p75: r[3] }
  return { p50: 180, p75: 900 }
}

let statsCache = null
let statsDirty = false
let statsLastWrite = 0

function loadStats() {
  if (statsCache) return statsCache
  try {
    const p = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'))
    statsCache = p && Array.isArray(p.samples)
      ? p.samples.filter((x) => x && isFinite(x.s) && isFinite(x.r)).slice(-STATS_MAX)
      : []
  } catch (_err) {
    statsCache = []
  }
  return statsCache
}

// 本机样本够 20 条/桶就用本机分位数，否则退回内置先验。
function learnedFor(step) {
  try {
    const s = Math.max(1, Math.floor(Number(step) || 1))
    const bucket = ETA_PRIOR.find((r) => s >= r[0] && s < r[1])
    if (!bucket) return null
    const arr = loadStats()
      .filter((x) => x.s >= bucket[0] && x.s < bucket[1])
      .map((x) => x.r)
      .sort((a, b) => a - b)
    if (arr.length < 20) return null
    return { p50: arr[Math.floor(arr.length * 0.5)], p75: arr[Math.floor(arr.length * 0.75)], n: arr.length }
  } catch (_err) {
    return null
  }
}

function recordSamples(rows) {
  if (!Array.isArray(rows) || !rows.length) return
  const all = loadStats()
  for (const r of rows) all.push(r)
  while (all.length > STATS_MAX) all.shift()
  statsCache = all
  statsDirty = true
}

function flushStats() {
  if (!statsDirty) return
  const now = Date.now()
  if (now - statsLastWrite < 15000) return
  statsLastWrite = now
  statsDirty = false
  try {
    const tmp = STATS_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: now, samples: statsCache }))
    fs.renameSync(tmp, STATS_FILE)
  } catch (_err) {}
}

// ============================================================================
// apply
// ============================================================================

const DEFAULT_CONFIG = {
  protocolHint: true, // 板关闭会话的文件上报协议注入开关
  pollMs: 1000,
  doneHoldMs: 30000,
  doneKeepMs: 120000,
  maxTasks: 64,
  // 观察者（给主工作模型看"最近输出+清单"，板滞后就及时补/催）
  observer: {
    enabled: true,
    maxIdleSteps: 6, // 模型超过 N 步未写板 → 观察块升级为催办
    maxIdleMs: 3 * 60 * 1000, // 或超过 N 毫秒未写板
    autoSyncCurrent: true, // 观察者本人用事实性最近动作自动刷 doing 项的 current
    autoSyncThrottleMs: 60 * 1000,
    maxOutputs: 2,
    maxTools: 3,
    maxItems: 12,
  },
  // v0.3.0：板 → 官方 todo 镜像与冲突裁决。默认 reconcile；不想要行为变更可在设置页关。
  todoSync: 'reconcile', // off | mirror | reconcile
  todo: { maxReconcileIntervalMs: 60_000, mirrorThrottleMs: 200 },
  // 辅助 LLM（审查/监视 + 槽位管理 + 轮次草案）：
  //   mode: 'registered' 走宿主 llm.stream（选已注册 llm-pi-ai provider/model）；
  //         'direct' 走自建 OpenAI 兼容端点（baseUrl/apiKey/model）；'' 关。
  //   authority: 'slots' 可增删改槽位 | 'rounds' 产轮次草案 | 'both'（默认）。
  assistant: {
    mode: '', // '' 关 | 'registered' | 'direct'
    provider: '', // registered：llm-pi-ai 里的 provider 名
    model: '', // registered/direct 共用的模型 id
    baseUrl: '', // direct
    apiKey: '', // direct
    authority: 'both', // slots | rounds | both
    timeoutMs: 20_000,
    minIntervalMs: 90_000,
    maxCallsPerTurn: 1,
    maxSlotChanges: 8, // 助手单次可改槽位数上限（护栏）
    autoApply: true,
  },
}

// .volatile() 字段在 0.1.7+ 宿主以 live ref（带 .get()）传入，旧宿主为普通值。
function unwrapLive(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    const snap = value.get()
    return snap === undefined ? undefined : snap
  }
  return value === undefined || value === null ? undefined : value
}

function readVolatile(value, fallback) {
  const v = unwrapLive(value)
  return v === undefined ? fallback : v
}

export async function apply(ctx, config) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, config && typeof config === 'object' ? config : {})
  // observer 的每个叶子都是 volatile（设置页可改）：统一每次读取时解包。
  const observerRaw = config && typeof config === 'object' ? config.observer : undefined
  function observerNow() {
    const base = DEFAULT_CONFIG.observer
    const raw = unwrapLive(observerRaw)
    if (!isObject(raw)) return { ...base }
    const out = { ...base }
    for (const key of Object.keys(base)) {
      const v = unwrapLive(raw[key])
      if (v !== undefined) out[key] = v
    }
    return out
  }
  // 用 getter 而不是快照：所有 `cfg.observer.x` 读点无需逐个改，设置页改完即生效。
  Object.defineProperty(cfg, 'observer', { get: observerNow, configurable: true, enumerable: true })
  const protocolHintRaw = config && typeof config === 'object' ? config.protocolHint : undefined
  Object.defineProperty(cfg, 'protocolHint', {
    get: () => readVolatile(protocolHintRaw, DEFAULT_CONFIG.protocolHint),
    configurable: true,
    enumerable: true,
  })
  // assistant 的每个字段都是 volatile：保留原始 ref（整对象或逐叶子皆可），
  // 每次读取时解包，设置页改完下一次审查即生效，无需重启。
  const assistantRaw = config && typeof config === 'object' ? config.assistant : undefined
  function assistantNow() {
    const base = DEFAULT_CONFIG.assistant
    const raw = unwrapLive(assistantRaw)
    if (!isObject(raw)) return { ...base }
    const out = { ...base }
    for (const key of Object.keys(base)) {
      const v = unwrapLive(raw[key])
      if (v !== undefined) out[key] = v
    }
    return out
  }
  cfg.assistant = assistantNow()
  // todoSync / todo 叶子同样逐次解包：设置页改完立即生效。
  const todoSyncRaw = config && typeof config === 'object' ? config.todoSync : undefined
  Object.defineProperty(cfg, 'todoSync', {
    get: () => readVolatile(todoSyncRaw, DEFAULT_CONFIG.todoSync),
    configurable: true, enumerable: true,
  })
  const todoRaw = config && typeof config === 'object' ? config.todo : undefined
  function todoNow() {
    const base = DEFAULT_CONFIG.todo
    const raw = unwrapLive(todoRaw)
    if (!isObject(raw)) return { ...base }
    const out = { ...base }
    for (const key of Object.keys(base)) {
      const v = unwrapLive(raw[key])
      if (v !== undefined) out[key] = v
    }
    return out
  }
  Object.defineProperty(cfg, 'todo', { get: todoNow, configurable: true, enumerable: true })
  const now = () => Date.now()

  // —— 状态容器 ——
  const states = new Map() // sessionId -> board state（槽位真相源）
  const lastKickoffAt = new Map()
  const taskMap = new Map() // sessionId -> 时间引擎派生态
  const userTextMap = new Map()
  let doneList = []
  const live = { status: 'idle', steps: 0, startAt: 0, lastActivityAt: 0 }
  let unit
  let storageError = ''
  let writeChain = Promise.resolve()

  const storage = ctx.get('storage')
  const webServer = ctx.get('webServer')
  const systemPrompt = ctx.get('systemPrompt')
  const tools = ctx.get('tools')
  const agents = ctx.get('agents')
  const commands = ctx.get('commands')
  const llm = ctx.get('llm')
  const settings = ctx.get('settings')
  if (!systemPrompt || !tools) throw new Error('dsh-progress-union 需要 systemPrompt 与 tools 服务')

  // settings 命名空间（面板可编辑的辅助 LLM 配置），composition config 作默认值。
  const ASSISTANT_NS = 'progress-union'
  function readAssistantSection() {
    if (!settings) return undefined
    try {
      let descriptor
      if (typeof settings.describe === 'function') {
        const raw = settings.describe()
        const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.namespaces) ? raw.namespaces : undefined)
        descriptor = list && list.find((row) => row && row.ns === ASSISTANT_NS)
        if (descriptor && descriptor.value !== undefined) return { value: descriptor.value, revision: descriptor.revision }
      }
      if (typeof settings.get === 'function') {
        const value = settings.get(ASSISTANT_NS)
        if (value !== undefined) return { value, revision: undefined }
      }
    } catch (_err) {}
    return undefined
  }
  // 运行时配置：设置页（volatile live ref）优先，settings 命名空间作补充覆盖。
  function liveAssistant() {
    const current = assistantNow()
    const section = readAssistantSection()
    const fromSettings = section && isObject(section.value) && isObject(section.value.assistant) ? section.value.assistant : undefined
    return fromSettings ? { ...current, ...fromSettings } : current
  }

  // ==========================================================================
  // A. board 核心（fork 语义原样：revision / 409 / 全成全败 / ack / userChanges）
  // ==========================================================================

  function isEnabled(sessionId) {
    return states.get(sessionId)?.enabled === true
  }

  function setEnabled(sessionId, enabled) {
    const state = ensureState(sessionId)
    if (state.enabled === enabled) return
    state.enabled = enabled
    void persist(sessionId)
  }

  if (storage) {
    try {
      const backendName = storage.backend.names().find((name) => {
        try {
          return Boolean(storage.backend.get(name).kv)
        } catch (_error) {
          return false
        }
      })
      if (backendName) {
        unit = await storage.backend.get(backendName).kv.open({
          name: UNIT_NAME,
          version: 1,
          tables: ['sessions'],
          hasGlobal: false,
          layout: 'per-record',
        })
        const all = await unit.loadAll()
        for (const stored of Object.values(all.tables.sessions || {})) {
          const record = isObject(stored) && isObject(stored.record) ? stored.record : stored
          if (!isObject(record) || typeof record.sessionId !== 'string' || !Array.isArray(record.items)) continue
          states.set(record.sessionId, record)
        }
      } else {
        storageError = '没有可用的 KV 存储后端，进度只保存在内存中。'
      }
    } catch (error) {
      storageError = `进度存储初始化失败，进度只保存在内存中：${error instanceof Error ? error.message : String(error)}`
    }
  } else {
    storageError = 'storage 服务不可用，进度只保存在内存中。'
  }

  function ensureState(sessionId) {
    let state = states.get(sessionId)
    if (!state) {
      state = emptyState(sessionId)
      states.set(sessionId, state)
    }
    for (const item of state.items) {
      if (typeof item.approach !== 'string') item.approach = ''
    }
    if (typeof state.enabled !== 'boolean') state.enabled = false
    if (state.todoMirror !== null && !isObject(state.todoMirror)) state.todoMirror = null
    if (!isObject(state.goal)) state.goal = emptyGoal()
    else {
      const g = state.goal
      if (!GOAL_PHASES.has(g.phase)) g.phase = 'idle'
      if (!Number.isSafeInteger(g.maxRounds) || g.maxRounds < 1) g.maxRounds = GOAL_DEFAULT_MAX_ROUNDS
      if (!Number.isSafeInteger(g.roundsStarted) || g.roundsStarted < 0) g.roundsStarted = 0
      if (!Number.isSafeInteger(g.blockedStreak) || g.blockedStreak < 0) g.blockedStreak = 0
      if (g.activation !== 'armed' && g.activation !== 'disarmed') g.activation = 'disarmed'
      if (!Number.isSafeInteger(g.currentRound) || g.currentRound < 0) g.currentRound = 0
      if (typeof g.objective !== 'string') g.objective = ''
      if (typeof g.id !== 'string' || !g.id) g.id = newGoalId()
    }
    return state
  }

  function persist(sessionId) {
    if (!unit) return writeChain
    const snapshot = clone(states.get(sessionId))
    writeChain = writeChain
      .then(async () => {
        await unit.putRecord('sessions', sessionKey(sessionId), snapshot)
        if (storageError.startsWith('进度保存失败')) storageError = ''
      })
      .catch((error) => {
        storageError = `进度保存失败，改动可能只在内存中：${error instanceof Error ? error.message : String(error)}`
      })
    return writeChain
  }

  // —— v0.3.0：官方 todo 镜像 + 冲突裁决（全在 apply 闭包内，共享 states/cfg）——
  const agentOfSession = new Map() // sessionId → agent（installAgentHook 时写入，disposed 清理）
  const todoMirrorTimers = new Map()
  const lastReconcileAt = new Map()
  const reconcileCallsThisTurn = new Map()

  function writeTodoMirror(sessionId, at) {
    const state = states.get(sessionId)
    if (!state || !state.enabled) return false
    const todos = boardToTodos(state, cfg.observer.maxItems)
    const hash = hashTodos(todos)
    const agent = agentOfSession.get(sessionId)
    if (!agent || !agent.session || typeof agent.session.append !== 'function') {
      // 旧宿主 / 测试基座无 append：静默降级，板与迷你条照旧。
      state.todoMirror = { hash: '', at, count: todos.length, unsupported: true }
      void persist(sessionId)
      return false
    }
    state.todoMirror = { hash, at, count: todos.length, unsupported: false }
    try {
      const result = agent.session.append('todo/write', { todos })
      if (result && typeof result.catch === 'function') void result.catch(() => {})
    } catch (_err) {
      state.todoMirror = { hash: '', at, count: todos.length, unsupported: true }
    }
    void persist(sessionId)
    return true
  }

  function scheduleTodoMirror(sessionId) {
    if (String(cfg.todoSync || 'off') === 'off') return
    const state = states.get(sessionId)
    if (!state || !state.enabled) return
    const delay = Math.max(0, Number(cfg.todo.mirrorThrottleMs) || 0)
    const prev = todoMirrorTimers.get(sessionId)
    if (prev) clearTimeout(prev)
    const timer = setTimeout(() => {
      todoMirrorTimers.delete(sessionId)
      try { writeTodoMirror(sessionId, now()) } catch (_err) {}
    }, delay)
    todoMirrorTimers.set(sessionId, timer)
  }

  function parseReconcile(raw) {
    const value = parseProposal(raw)
    if (!value) return null
    const resolution = String(value.resolution || '')
    if (!['adopt-todo', 'keep-board', 'merge'].includes(resolution)) return null
    const board = isObject(value.board) ? value.board : {}
    const changes = Array.isArray(board.changes) ? board.changes : []
    const todo = isObject(value.todo) ? value.todo : {}
    return {
      resolution,
      board: { changes },
      todo: Array.isArray(todo.todos) ? { todos: todo.todos } : undefined,
      note: String(value.note || '').slice(0, 200),
    }
  }

  function todoItemsToBoardChanges(state, todos) {
    const changes = state.items.slice()
      .sort((a, b) => a.order - b.order)
      .map((item) => ({ id: item.id, remove: true }))
    const seen = new Set()
    for (const t of todos.slice(0, Math.max(0, MAX_CHANGES - changes.length))) {
      if (!isObject(t)) continue
      const title = text(String(t.content ?? ''), MAX_TITLE)
      if (!title || seen.has(title)) continue
      seen.add(title)
      const st = String(t.status || '')
      const status = st === 'completed' ? 'done' : st === 'in_progress' ? 'doing' : 'todo'
      changes.push({ title, status })
    }
    return changes.slice(0, MAX_CHANGES)
  }

  async function maybeReconcileTodo(sid, incomingTodos, incomingHash) {
    if (String(cfg.todoSync || '') !== 'reconcile') return
    if (!assistantReady() || !isEnabled(sid)) return
    const mirror = todoMirrorOf(states.get(sid))
    if (mirror && !mirror.unsupported && incomingHash === mirror.hash) return
    const at = now()
    if (at - (lastReconcileAt.get(sid) || 0) < Math.max(0, Number(cfg.todo.maxReconcileIntervalMs) || 0)) return
    if ((reconcileCallsThisTurn.get(sid) || 0) >= 1) return
    reconcileCallsThisTurn.set(sid, (reconcileCallsThisTurn.get(sid) || 0) + 1)
    lastReconcileAt.set(sid, at)
    const a = liveAssistant()
    const state = states.get(sid)
    const o = obsOf(sid)
    const todoLines = incomingTodos.slice(0, cfg.observer.maxItems)
      .map((t, i) => `${i + 1}. [${String(t && t.status || '')}] ${String(t && t.content || '')}`)
    const lastOutput = o.outputs[o.outputs.length - 1]
    const lines = [
      '进度板（真相源）：',
      ...renderChecklist(state, cfg.observer.maxItems),
      '官方 todo（外部改动）：',
      ...todoLines,
      lastOutput ? `最近输出：${lastOutput.text}` : '最近输出：—',
      o.tools.length ? `最近动作：${o.tools.slice(-cfg.observer.maxTools).map((x) => x.name).join(' → ')}` : '最近动作：—',
    ]
    try {
      const raw = await callAssistant({ system: TODO_RECONCILE_SYSTEM, user: lines.join('\n'), a })
      const decision = parseReconcile(raw)
      if (!decision) throw new Error('reconcile-unparsable')
      if (decision.resolution === 'adopt-todo') {
        await applyChanges({ sessionId: sid, changes: todoItemsToBoardChanges(state, incomingTodos), origin: 'assistant' })
      } else if (decision.resolution === 'merge') {
        const g = applyAssistantSlotChanges(state, sid, decision, a)
        if (g.count > 0) await applyChanges({ sessionId: sid, changes: g.changes, origin: 'assistant', ackUserRevision: g.ackUserRevision })
      }
      // keep-board 不改板；三支都重写镜像（落地后 todo 与板一致）。
      writeTodoMirror(sid, now())
      o.assistantNote = `todo 裁决：${decision.resolution}${decision.note ? ' · ' + decision.note : ''}`
      o.assistantError = ''
    } catch (err) {
      // 失败/超时/坏 JSON：两侧均不改，只记错误；观察块给漂移行。
      o.assistantError = err instanceof Error ? err.message : String(err)
    }
  }

  // 通用助手传输：registered 走 llm.stream，direct 走 fetch；两条链路共用。
  async function callAssistant({ system, user, a }) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(2000, Number(a.timeoutMs) || 20000))
    try {
      if (a.mode === 'registered') {
        // system 必须走 options.system；content 必须是 ContentBlock[]（0.1.7 契约回归）。
        const stream = llm.stream({
          provider: String(a.provider),
          model: String(a.model),
          system,
          messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
          signal: controller.signal,
        })
        let raw = ''
        for await (const chunk of stream) {
          if (controller.signal.aborted) break
          if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') raw += chunk.text
          else if (chunk && chunk.type === 'finish' && chunk.reason && chunk.reason.kind !== 'stop' && chunk.reason.kind !== 'max-tokens') {
            throw new Error(`assistant finish: ${chunk.reason.kind}`)
          }
        }
        if (raw.trim() === '') throw new Error('assistant-empty')
        return raw
      }
      const base = String(a.baseUrl || '').replace(/\/+$/, '')
      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(String(a.apiKey || '') !== '' ? { authorization: `Bearer ${a.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: a.model,
          temperature: 0,
          max_tokens: 600,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      return String(body?.choices?.[0]?.message?.content ?? '')
    } finally {
      clearTimeout(timer)
    }
  }

  function publicSnapshot(state) {
    const items = state.items.slice().sort((a, b) => a.order - b.order).map(itemView)
    return {
      ok: true,
      sessionId: state.sessionId,
      revision: state.revision,
      userRevision: state.userRevision,
      agentSeenRevision: state.agentSeenRevision,
      enabled: state.enabled === true,
      pendingUserChanges: state.userChanges.filter((change) => change.revision > state.agentSeenRevision).length,
      updatedAt: state.updatedAt,
      persistent: Boolean(unit) && !storageError.includes('失败'),
      storageError: storageError || null,
      items,
      summary: summarize(items),
      // v0.3.0：官方 todo 同步状态回声
      todo: (() => {
        const m = todoMirrorOf(state)
        return {
          sync: String(cfg.todoSync || 'off'),
          mirroredAt: m ? m.at : 0,
          count: m ? m.count : 0,
          unsupported: m ? m.unsupported : false,
        }
      })(),
      // /progress-goal 迷你目标域回声
      goal: state.goal ? goalView(state.sessionId) : null,
      // 辅助 LLM 的配置回声：只回非机密字段，apiKey 只回布尔
      assistant: (() => {
        const a = liveAssistant()
        return {
          enabled: assistantReady(),
          mode: a.mode || '',
          provider: String(a.provider || ''),
          baseUrl: String(a.baseUrl || ''),
          model: String(a.model || ''),
          hasApiKey: String(a.apiKey || '') !== '',
          authority: a.authority || 'both',
          minIntervalMs: Number(a.minIntervalMs) || 0,
          autoApply: a.autoApply !== false,
        }
      })(),
      serverTime: now(),
    }
  }

  function findItem(state, change) {
    if (typeof change.id === 'string' && change.id.trim()) {
      const id = change.id.trim()
      return state.items.find((item) => item.id === id)
    }
    if (typeof change.title === 'string' && change.title.trim()) {
      const title = change.title.trim()
      const matches = state.items.filter((item) => item.title === title)
      if (matches.length > 1) {
        throw new Error(`标题「${title}」对应多个任务，请用 id 指定`)
      }
      return matches[0]
    }
    return undefined
  }

  function applyOneChange(state, change, origin, at, records) {
    if (!isObject(change)) throw new Error('changes 的每一项必须是对象')
    const remove = change.remove === true
    const existing = findItem(state, change)

    if (remove) {
      if (!existing) throw new Error(`找不到要删除的任务：${change.id || change.title || '(未提供 id/title)'}`)
      state.items = state.items.filter((item) => item.id !== existing.id)
      records.push({ kind: 'remove', itemId: existing.id, title: existing.title, fields: [] })
      return
    }

    const hasTitle = typeof change.title === 'string' && change.title.trim()
    if (!existing && !hasTitle) {
      throw new Error('新增任务必须提供 title；更新任务必须提供 id 或精确 title')
    }

    if (!existing) {
      if (state.items.length >= MAX_ITEMS) throw new Error(`任务数量已达到上限 ${MAX_ITEMS}`)
      const title = text(change.title, MAX_TITLE)
      if (!title) throw new Error('任务标题不能为空')
      const status = STATUSES.has(change.status) ? change.status : 'todo'
      const percent = status === 'done' ? 100 : Math.max(0, Math.min(100, Math.round(finiteNumber(change.percent) ?? 0)))
      const item = {
        id: newItemId(),
        title,
        status,
        percent,
        current: text(change.current, MAX_TEXT) || '',
        next: text(change.next, MAX_TEXT) || '',
        approach: text(change.approach, MAX_APPROACH) || '',
        note: text(change.note, MAX_NOTE) || '',
        group: text(change.group, MAX_GROUP) || '',
        order: state.items.length,
        updatedAt: at,
        updatedBy: origin,
      }
      state.items.push(item)
      records.push({
        kind: 'add',
        itemId: item.id,
        title: item.title,
        fields: [
          { field: 'status', from: null, to: item.status },
          { field: 'percent', from: null, to: item.percent },
        ],
      })
      return
    }

    const fields = []
    function record(field, from, to) {
      if (Object.is(from, to)) return
      fields.push({ field, from, to })
    }

    if (typeof change.title === 'string') {
      const nextTitle = text(change.title, MAX_TITLE)
      if (!nextTitle) throw new Error('任务标题不能为空')
      record('title', existing.title, nextTitle)
      existing.title = nextTitle
    }

    if (typeof change.status === 'string') {
      if (!STATUSES.has(change.status)) throw new Error(`未知状态：${change.status}`)
      record('status', existing.status, change.status)
      existing.status = change.status
      if (change.status === 'done') {
        record('percent', existing.percent, 100)
        existing.percent = 100
      }
    }

    if (change.percent !== undefined) {
      const value = finiteNumber(change.percent)
      if (value === undefined) throw new Error('percent 必须是 0–100 的数字')
      const nextPercent = Math.max(0, Math.min(100, Math.round(value)))
      record('percent', existing.percent, nextPercent)
      existing.percent = nextPercent
    }

    if (existing.status === 'done' && existing.percent !== 100) {
      record('percent', existing.percent, 100)
      existing.percent = 100
    }

    for (const [field, max] of [
      ['current', MAX_TEXT],
      ['next', MAX_TEXT],
      ['approach', MAX_APPROACH],
      ['note', MAX_NOTE],
      ['group', MAX_GROUP],
    ]) {
      if (typeof change[field] === 'string') {
        const nextValue = text(change[field], max) || ''
        record(field, existing[field], nextValue)
        existing[field] = nextValue
      }
    }

    if (change.order !== undefined) {
      const nextOrder = finiteNumber(change.order)
      if (nextOrder === undefined) throw new Error('order 必须是数字')
      record('order', existing.order, nextOrder)
      existing.order = nextOrder
    }

    if (fields.length > 0) {
      existing.updatedAt = at
      existing.updatedBy = origin
      records.push({ kind: 'edit', itemId: existing.id, title: existing.title, fields })
    }
  }

  async function applyChanges({ sessionId, changes, origin, expectedRevision, ackUserRevision }) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 240) {
      throw new Error('无效的 sessionId')
    }
    if (!Array.isArray(changes)) throw new Error('changes 必须是数组')
    if (changes.length > MAX_CHANGES) throw new Error(`一次最多提交 ${MAX_CHANGES} 项改动`)
    if (expectedRevision !== undefined && finiteNumber(expectedRevision) === undefined) {
      throw new Error('expectedRevision 必须是数字')
    }

    const state = ensureState(sessionId)
    if (expectedRevision !== undefined && expectedRevision !== state.revision) {
      const error = new Error('进度板已被更新，请先刷新再提交')
      error.statusCode = 409
      error.snapshot = publicSnapshot(state)
      throw error
    }

    // 批量改动在一次性克隆上验证并应用：半途失败会经由 HTTP 重试与 409 重放
    // 变成重复或半应用任务（board 原教训，原样保留）。
    const working = clone(state)
    const records = []
    const at = now()
    for (const change of changes) applyOneChange(working, change, origin, at, records)

    let revisionChanged = false
    if (records.length > 0) {
      working.revision += 1
      working.updatedAt = at
      normalizeItems(working.items)
      for (const record of records) {
        if (record.kind !== 'edit') continue
        const orderField = record.fields.find((field) => field.field === 'order')
        if (orderField) {
          const after = working.items.find((item) => item.id === record.itemId)
          if (after) orderField.to = after.order
        }
      }
      if (origin === 'user') {
        working.userRevision = working.revision
        for (const record of records) working.userChanges.push({ revision: working.revision, at, ...record })
        if (working.userChanges.length > MAX_USER_CHANGES) {
          working.userChanges.splice(0, working.userChanges.length - MAX_USER_CHANGES)
        }
      }
      revisionChanged = true
    }

    if (origin === 'agent' && ackUserRevision !== undefined) {
      const ack = finiteNumber(ackUserRevision)
      if (ack !== undefined) {
        working.agentSeenRevision = Math.max(working.agentSeenRevision, Math.min(working.userRevision, Math.round(ack)))
      }
    }

    if (revisionChanged || (origin === 'agent' && ackUserRevision !== undefined)) {
      states.set(sessionId, working)
      await persist(sessionId)
      // 唯一写板入口：持久化之后调度 todo 镜像（200ms 去抖，off 时直接返回）。
      if (revisionChanged) scheduleTodoMirror(sessionId)
    }
    // 任何 agent 调用（含 changes=[] 确认）都算一次"模型已看板"：重置催办计时；
    // 观察者自己的 autoSync（origin='observer'）只刷新板新鲜度，不抵消模型催办。
    if (origin === 'agent' || revisionChanged) noteBoardWrite(sessionId, origin, at)

    const changed = records.map((record) => {
      if (record.kind === 'remove') return { id: record.itemId, title: record.title, removed: true }
      return {
        id: record.itemId,
        title: record.title,
        change: record.kind,
        fields: record.fields.map((field) => field.field),
      }
    })
    return { snapshot: publicSnapshot(working), changed: changed.filter(Boolean) }
  }

  // ==========================================================================
  // A2. /progress-goal 迷你目标域（预算 / 检查 / 重试 三件套）
  //     自建、不走官方 goals 域：避免 /goal 的 pre-step 身份校验被本插件注入污染。
  // ==========================================================================

  function goalView(sessionId) {
    const state = ensureState(sessionId)
    const g = state.goal
    const summary = summarize(state.items.slice().sort((a, b) => a.order - b.order).map(itemView))
    return {
      objective: g.objective,
      phase: g.phase,
      maxRounds: g.maxRounds,
      roundsStarted: g.roundsStarted,
      blockedStreak: g.blockedStreak,
      blockedReason: g.blockedReason,
      activation: g.activation,
      currentRound: g.currentRound,
      board: summary,
    }
  }

  function goalPhaseLabel(phase) {
    return GOAL_PHASES.has(phase) ? phase : 'idle'
  }

  // 板是否全部完成（>0 项且全 done）——"检查"的真相源，避免猜消息身份。
  function goalBoardComplete(state) {
    return state.items.length > 0 && state.items.every((item) => item.status === 'done')
  }

  async function saveGoal(sessionId) {
    const state = ensureState(sessionId)
    state.updatedAt = now()
    await persist(sessionId)
    return state.goal
  }

  async function createGoal(sessionId, objective) {
    const state = ensureState(sessionId)
    if (state.goal.phase === 'active' || state.goal.phase === 'paused' || state.goal.phase === 'blocked') {
      throw new Error(`目标当前为 ${goalPhaseLabel(state.goal.phase)}；先用 /progress-goal clear 清除，或 edit 改目标。`)
    }
    const clean = text(objective, 600)
    if (!clean) throw new Error('目标内容不能为空')
    state.goal = {
      ...emptyGoal(),
      objective: clean,
      phase: 'active',
      activation: 'armed',
    }
    await saveGoal(sessionId)
    return goalView(sessionId)
  }

  async function editGoal(sessionId, objective) {
    const state = ensureState(sessionId)
    if (state.goal.phase === 'idle') throw new Error('没有可编辑的目标')
    const clean = text(objective, 600)
    if (!clean) throw new Error('目标内容不能为空')
    state.goal.objective = clean
    if (state.goal.phase === 'complete') {
      state.goal.phase = 'active'
      state.goal.activation = 'armed'
      state.goal.roundsStarted = 0
      state.goal.blockedStreak = 0
      state.goal.blockedReason = null
    }
    await saveGoal(sessionId)
    return goalView(sessionId)
  }

  async function setGoalBudget(sessionId, value) {
    const state = ensureState(sessionId)
    if (state.goal.phase === 'idle') throw new Error('没有目标可设置预算')
    const n = finiteNumber(value)
    if (n === undefined || !Number.isSafeInteger(n) || n < 1) throw new Error('预算必须是 ≥1 的整数')
    state.goal.maxRounds = Math.min(n, 100000)
    await saveGoal(sessionId)
    return goalView(sessionId)
  }

  async function pauseGoal(sessionId) {
    const state = ensureState(sessionId)
    if (state.goal.phase === 'idle') throw new Error('没有可暂停的目标')
    if (state.goal.phase !== 'active') throw new Error(`只有 active 目标可暂停（当前 ${goalPhaseLabel(state.goal.phase)}）`)
    state.goal.phase = 'paused'
    state.goal.activation = 'disarmed'
    state.goal.currentRound = 0
    await saveGoal(sessionId)
    return goalView(sessionId)
  }

  async function resumeGoal(sessionId) {
    const state = ensureState(sessionId)
    if (state.goal.phase !== 'paused' && state.goal.phase !== 'blocked') {
      throw new Error(`只有 paused/blocked 目标可恢复（当前 ${goalPhaseLabel(state.goal.phase)}）`)
    }
    if (state.goal.roundsStarted >= state.goal.maxRounds) {
      state.goal.roundsStarted = 0 // 预算已耗尽时恢复 = 新的一轮预算
    }
    state.goal.phase = 'active'
    state.goal.activation = 'armed'
    state.goal.blockedStreak = 0
    state.goal.blockedReason = null
    await saveGoal(sessionId)
    return goalView(sessionId)
  }

  async function clearGoal(sessionId) {
    const state = ensureState(sessionId)
    state.goal = emptyGoal()
    await saveGoal(sessionId)
    return goalView(sessionId)
  }

  // 模型每轮末调用 progress_goal_report 报状态；助手草案只作建议、不自动调这里。
  async function applyGoalReport(sessionId, report) {
    const state = ensureState(sessionId)
    const g = state.goal
    if (g.phase !== 'active') throw new Error(`目标当前为 ${goalPhaseLabel(g.phase)}，只有 active 目标可上报`)
    if (!isObject(report)) throw new Error('上报必须是对象')
    const status = String(report.status || '')
    if (!['continue', 'complete', 'blocked'].includes(status)) throw new Error('status 必须是 continue/complete/blocked')

    if (status === 'complete') {
      const evidence = Array.isArray(report.evidence) ? report.evidence.filter((e) => typeof e === 'string' && e.trim()) : []
      if (evidence.length === 0) throw new Error('complete 必须提供至少一条证据 evidence')
      if (!goalBoardComplete(state)) throw new Error('complete 被拒：进度板尚未全部完成（先更新板再报完成）')
      g.phase = 'complete'
      g.activation = 'disarmed'
      g.currentRound = 0
      g.blockedStreak = 0
      g.blockedReason = null
      await saveGoal(sessionId)
      return goalView(sessionId)
    }

    if (status === 'blocked') {
      const reason = text(report.blocker, 400) || '未提供阻塞原因'
      if (g.blockedReason === reason) g.blockedStreak += 1
      else { g.blockedReason = reason; g.blockedStreak = 1 }
      if (g.blockedStreak >= GOAL_BLOCK_STREAK) {
        g.phase = 'blocked'
        g.activation = 'disarmed'
        g.currentRound = 0
      }
      await saveGoal(sessionId)
      return goalView(sessionId)
    }

    // continue：确认有实质进展，清 blocked 累积，轮次计数不在这里（由驱动器派发时计）
    g.blockedStreak = 0
    g.blockedReason = null
    await saveGoal(sessionId)
    return goalView(sessionId)
  }

  function renderGoalViewText(view) {
    const parts = [
      `Objective: ${JSON.stringify(view.objective)}`,
      `Status: ${goalPhaseLabel(view.phase)}`,
      `Rounds: ${view.roundsStarted}/${view.maxRounds}`,
      `Activation: ${view.activation}`,
      `Board: ${view.board.done}/${view.board.total} done · ${view.board.percent}%`,
    ]
    if (view.blockedReason) parts.push(`Blocker: ${view.blockedReason} (streak ${view.blockedStreak}/${GOAL_BLOCK_STREAK})`)
    return parts.join('\n')
  }

  // —— 续轮驱动器（重试）：idle → followup 带自有 source 的 <progress_goal_round> ——
  // 每 agent 一个 attempt 状态：queued/claimed/cancelled + 串行 FIFO；官方 driver 的轻量版。
  const goalDrives = new WeakMap() // agent -> {attempt, requested, run, stopping}

  function driveStateFor(agent) {
    let s = goalDrives.get(agent)
    if (!s) {
      s = { attempt: undefined, requested: false, run: undefined, stopping: false }
      goalDrives.set(agent, s)
    }
    return s
  }

  function sameGoalSource(message, attempt) {
    if (!attempt || !message || !message.source) return false
    const src = message.source
    return src.kind === GOAL_SOURCE_KIND && src.goalId === attempt.goalId && src.revision === attempt.revision && src.round === attempt.round
  }

  function isGoalRoundMessage(message) {
    return Boolean(message && message.source && message.source.kind === GOAL_SOURCE_KIND && message.source.round > 0)
  }

  // 构造 followup 消息的 content，把板清单与助手轮次草案（若有）拼进去。
  function renderGoalRoundContent(sessionId, round, view) {
    const state = states.get(sessionId)
    const checklist = state ? renderChecklist(state, cfg.observer.maxItems).join('\n') : '(空板)'
    const parts = [
      `${GOAL_TAG}`,
      `Objective: ${JSON.stringify(view.objective)}`,
      `Round: ${round}/${view.maxRounds}`,
      '',
      '<progress-board-snapshot>',
      checklist,
      '</progress-board-snapshot>',
    ]
    if (oRoundDraftOf(sessionId)) parts.push('', `助手建议：${oRoundDraftOf(sessionId)}`)
    parts.push(
      '',
      '继续在**同一会话**朝目标推进：以当前工作区、工具结果与持久化状态为准，先核对进度板再行动；做出实质进展并验证。',
      '若要收尾，先确保进度板全部完成，再调用 progress_goal_report 报 status=complete 并给出 evidence。若受阻，报 status=blocked 并写清 blocker。否则报 status=continue，本目标会自动进入下一轮。',
      '每轮至少用 progress_update 同步一次进度板（无变化传 changes=[]）。',
      `${GOAL_TAG}`,
    )
    return [{ type: 'text', text: parts.join('\n') }]
  }

  // 助手轮次草案：存在 observers 上，由 Phase3 的辅助 LLM 写入；这里只读。
  function oRoundDraftOf(sid) {
    const o = observers.get(sid)
    return o && typeof o.roundDraft === 'string' && o.roundDraft ? o.roundDraft.slice(0, 400) : ''
  }

  async function driveGoal(state) {
    const { agent } = state
    const sessionId = String(agent.session?.id ?? agent.id)
    const current = ensureState(sessionId)
    const g = current.goal
    // 让路：官方目标 active 时不排队
    try {
      const official = ctx.get('goals')?.get?.(agent)
      if (official && official.phase === 'active' && official.activation === 'armed') return
    } catch (_err) {}
    if (g.phase !== 'active' || g.activation !== 'armed') return
    if (g.roundsStarted >= g.maxRounds) {
      g.phase = 'blocked'
      g.activation = 'disarmed'
      g.blockedReason = `达到预算上限 ${g.maxRounds} 轮`
      g.blockedStreak = 1
      g.currentRound = 0
      await saveGoal(sessionId)
      return
    }
    const round = g.roundsStarted + 1
    const revision = current.revision
    const content = renderGoalRoundContent(sessionId, round, goalView(sessionId))
    const message = {
      id: `pg-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      content,
      source: { kind: GOAL_SOURCE_KIND, goalId: g.id, revision, round },
    }
    // 声称本轮：写 currentRound + roundsStarted，避免重复派发
    g.currentRound = round
    g.roundsStarted = round
    await saveGoal(sessionId)
    state.attempt = { goalId: g.id, revision, round, messageId: message.id, phase: 'queued', stale: false }
    try {
      if (typeof agent.followup !== 'function') throw new Error('agent.followup unavailable')
      agent.followup(message)
    } catch (err) {
      state.attempt = undefined
      g.phase = 'blocked'
      g.activation = 'disarmed'
      g.blockedReason = `续轮派发失败：${err instanceof Error ? err.message : String(err)}`
      await saveGoal(sessionId)
    }
  }

  function requestGoalDrive(agent) {
    const state = driveStateFor(agent)
    if (state.stopping) return
    state.requested = true
    if (state.run !== undefined) return
    let run
    try {
      run = (async () => {
        while (state.requested && !state.stopping) {
          state.requested = false
          try {
            await driveGoal(state)
          } catch (_err) {
            // 单轮失败静默，不阻断后续
          }
        }
      })()
    } catch (_err) {
      state.run = undefined
      return
    }
    state.run = run
    const retire = () => {
      state.run = undefined
      if (state.requested && !state.stopping) requestGoalDrive(agent)
    }
    run.then(retire, retire)
  }

  // ==========================================================================
  // B. 注入面（board 三块照板 + 鲸程文件上报协议收敛）
  // ==========================================================================

  function pendingContext(sessionId) {
    if (!isEnabled(sessionId)) return ''
    const state = states.get(sessionId)
    if (!state || state.userRevision <= state.agentSeenRevision) return ''
    const changes = state.userChanges.filter((change) => change.revision > state.agentSeenRevision).slice(-20)
    if (changes.length === 0) return ''
    const lines = changes.map(describeChange)
    return `<progress-board-user-edits revision="${state.userRevision}">
用户在进度板上做了以下改动。只依据这些改动调整方向，不要重读整份计划；用户改动优先于你原来的计划。
${lines.join('\n')}
处理完后调用 progress_update，传 ackUserRevision=${state.userRevision}。如果这些改动不要求修改任务，也可以传 changes=[] 仅确认收到。
</progress-board-user-edits>`
  }

  function kickoffContext(sessionId) {
    if (!isEnabled(sessionId)) return ''
    const state = states.get(sessionId)
    if (!state || state.items.length === 0) {
      return `<progress-board-kickoff>
进度板已启用但当前为空。本回合的第一个工具调用必须是 progress_update：先建立 2–5 个扁平任务（第一项设为 doing，current 写正在做什么），然后再调用其他工具或开始实现。
</progress-board-kickoff>`
    }
    // 板走完计划是更新静默停下的地方：空板之外，全完成或超 10 分钟没更新都再推一次。
    const allDone = state.items.every((item) => item.status === 'done')
    const idleMs = now() - (finiteNumber(state.updatedAt) ?? 0)
    if (!allDone && idleMs < STALE_MS) return ''
    // 投影每次 model request 重建而非每回合一次：一回合至多推一次，避免每步都邀请 changes=[]。
    const at = now()
    const lastNudge = lastKickoffAt.get(sessionId) ?? 0
    if (at - lastNudge < KICKOFF_COOLDOWN_MS) return ''
    lastKickoffAt.set(sessionId, at)
    const reason = allDone
      ? '进度板上的任务已全部完成'
      : `进度板已有 ${Math.round(idleMs / 60000)} 分钟没有更新`
    return `<progress-board-kickoff>
${reason}。本回合开始前先用 progress_update 处理进度板：用户这条消息是新任务就先增补任务（第一项设为 doing，current 写正在做什么）再动手；不是新任务就传 changes=[] 确认。不要重发整份旧计划。
</progress-board-kickoff>`
  }

  // ==========================================================================
  // B2. 观察者（辅助主模型观察最近输出/清单；板滞后先自动补事实性 current，再催办）
  //     依据：assistant/message（最近输出）、tool/call（最近动作）、
  //     step/start（距上一次写板的步数）——都是会话事件里的事实，不做语义猜测。
  // ==========================================================================

  const observers = new Map()

  function obsOf(sid) {
    let o = observers.get(sid)
    if (!o) {
      const at = now()
      o = { outputs: [], tools: [], lastBoardAt: at, lastModelAt: at, stepsSinceBoard: 0, stepsSinceModel: 0, lastAutoSyncAt: 0,
        assistantCalls: 0, lastAssistantAt: 0, assistantNote: '', assistantError: '' }
      observers.set(sid, o)
    }
    return o
  }

  // board 写后重置计数器：origin='observer'/'assistant' 只刷新"板新鲜度"，不抵消"模型未同步"。
  function noteBoardWrite(sid, origin, at) {
    const o = obsOf(sid)
    o.lastBoardAt = at
    o.stepsSinceBoard = 0
    if (origin !== 'observer' && origin !== 'assistant') {
      o.lastModelAt = at
      o.stepsSinceModel = 0
    }
  }

  function briefArgs(raw) {
    try {
      const v = JSON.parse(String(raw || ''))
      if (isObject(v)) {
        for (const key of ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'name', 'title']) {
          if (typeof v[key] === 'string' && v[key].trim()) return `${key}=${v[key].trim().slice(0, 70)}`
        }
        const lines = JSON.stringify(v)
        return lines.length > 90 ? lines.slice(0, 90) + '…' : lines
      }
    } catch (_err) {}
    const s = String(raw || '').trim()
    return s.length > 90 ? s.slice(0, 90) + '…' : s
  }

  function recordTool(sid, data) {
    const d = data || {}
    if (typeof d.name !== 'string' || !d.name) return
    const o = obsOf(sid)
    const at = now()
    o.tools.push({ at, name: d.name, brief: briefArgs(d.arguments) })
    if (o.tools.length > 8) o.tools.splice(0, o.tools.length - 8)
    // 文件改动（事实级）：任何带路径类参数的工具调用都记一笔，同路径去重留最新
    const file = filePathOf(d.arguments)
    if (file) {
      o.files = (o.files || []).filter((x) => x.path !== file)
      o.files.push({ path: file, tool: d.name, at })
      if (o.files.length > 6) o.files.splice(0, o.files.length - 6)
    }
  }

  // 只认路径类参数（覆盖主流 fs 工具命名），拿不到就不记——不猜。
  function filePathOf(raw) {
    try {
      const v = JSON.parse(String(raw || ''))
      if (isObject(v)) {
        for (const key of ['file_path', 'path', 'abs_path', 'target_file', 'filePath']) {
          if (typeof v[key] === 'string' && v[key].trim()) return v[key].trim()
        }
      }
    } catch (_err) {}
    return ''
  }

  function shortPath(p) {
    const s = String(p || '')
    return s.length > 64 ? '…' + s.slice(-64) : s
  }

  function recordOutput(sid, data) {
    const msg = data && data.message ? data.message : data
    const t = textOf(msg).replace(/\s+/g, ' ').trim()
    if (!t) return
    const o = obsOf(sid)
    o.outputs.push({ at: now(), text: t.length > 160 ? t.slice(0, 160) + '…' : t })
    if (o.outputs.length > 4) o.outputs.splice(0, o.outputs.length - 4)
  }

  // 板上还有活干才算"需要催"：全完成/空板不打扰。
  function boardHasWork(sid) {
    const s = states.get(sid)
    return Boolean(s && s.enabled && s.items.some((item) => item.status !== 'done'))
  }

  function modelIsLate(sid, at) {
    const o = obsOf(sid)
    return o.stepsSinceModel >= cfg.observer.maxIdleSteps || at - o.lastModelAt >= cfg.observer.maxIdleMs
  }

  // 观察者自动补 current：只用事实（最近一次工具调用），不动 status/percent。
  function maybeAutoSync(sid, at) {
    if (!cfg.observer.autoSyncCurrent) return
    if (!cfg.observer.enabled || !boardHasWork(sid)) return
    const o = obsOf(sid)
    if (o.stepsSinceBoard < cfg.observer.maxIdleSteps && at - o.lastBoardAt < cfg.observer.maxIdleMs) return
    if (at - o.lastAutoSyncAt < cfg.observer.autoSyncThrottleMs) return
    const lastTool = o.tools[o.tools.length - 1]
    if (!lastTool || at - lastTool.at > cfg.observer.maxIdleMs) return
    const state = states.get(sid)
    const doing = state.items.find((item) => item.status === 'doing')
    if (!doing) return
    const line = `自动同步：${lastTool.name}${lastTool.brief ? ' · ' + lastTool.brief : ''}`.slice(0, MAX_TEXT)
    if (doing.current === line) return
    o.lastAutoSyncAt = at
    void applyChanges({ sessionId: sid, changes: [{ id: doing.id, current: line }], origin: 'observer' }).catch(() => {})
  }

  // —— 辅助 LLM：registered（宿主 llm.stream） / direct（自建端点），默认关 ——
  function assistantReady() {
    const a = liveAssistant()
    if (a.mode === 'registered') {
      return Boolean(llm && typeof llm.stream === 'function')
        && String(a.provider || '').trim() !== ''
        && String(a.model || '').trim() !== ''
    }
    if (a.mode === 'direct') {
      return String(a.baseUrl || '').trim() !== '' && String(a.model || '').trim() !== ''
    }
    return false
  }

  // 从模型回复里抠出唯一 JSON 对象（容忍 ```json 围栏与前后废话）。
  function parseProposal(raw) {
    const text = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
      const value = JSON.parse(text.slice(start, end + 1))
      return isObject(value) ? value : null
    } catch (_err) {
      return null
    }
  }

  /**
   * 板滞后（或模型久未同步）时问一次辅助模型。失败静默（记 assistantError），
   * 绝不阻断主流程；每回合至多 maxCallsPerTurn 次、两次至少间隔 minIntervalMs。
   */
  // 把助手 proposal 的 board.changes 校验+落地。护栏：≤maxSlotChanges、用户改动优先（先 ack）。
  function applyAssistantSlotChanges(state, sid, proposal, a) {
    const board = isObject(proposal.board) ? proposal.board : {}
    const rawChanges = Array.isArray(board.changes) ? board.changes : []
    if (rawChanges.length === 0) return { count: 0, ackUserRevision: undefined }
    const byId = new Map(state.items.map((item) => [item.id, item]))
    const changes = []
    // 用户未确认的改动优先：本次先 ack，助手不得覆盖它们。
    const ackUserRevision = state.userRevision > state.agentSeenRevision ? state.userRevision : undefined
    for (const candidate of rawChanges.slice(0, Math.max(1, Number(a.maxSlotChanges) || 8))) {
      if (!isObject(candidate)) continue
      const kind = String(candidate.kind || (candidate.id ? 'edit' : 'add'))
      if (kind === 'add') {
        const title = text(candidate.title, MAX_TITLE)
        if (!title) continue
        const patch = { title }
        if (STATUSES.has(candidate.status)) patch.status = candidate.status
        if (typeof candidate.percent === 'number' && Number.isFinite(candidate.percent)) patch.percent = Math.max(0, Math.min(100, Math.round(candidate.percent)))
        if (typeof candidate.current === 'string') patch.current = text(candidate.current, MAX_TEXT) || ''
        if (typeof candidate.next === 'string') patch.next = text(candidate.next, MAX_TEXT) || ''
        if (typeof candidate.note === 'string') patch.note = text(candidate.note, MAX_NOTE) || ''
        changes.push(patch)
      } else if (kind === 'remove') {
        const target = byId.get(String(candidate.id || ''))
        if (target) changes.push({ id: target.id, remove: true })
      } else if (kind === 'edit') {
        const target = byId.get(String(candidate.id || ''))
        if (!target) continue
        const patch = { id: target.id }
        if (STATUSES.has(candidate.status)) patch.status = candidate.status
        if (typeof candidate.percent === 'number' && Number.isFinite(candidate.percent)) patch.percent = Math.max(0, Math.min(100, Math.round(candidate.percent)))
        for (const field of ['current', 'next', 'note']) {
          if (typeof candidate[field] === 'string') patch[field] = text(candidate[field], field === 'note' ? MAX_NOTE : MAX_TEXT) || ''
        }
        if (Object.keys(patch).length > 1) changes.push(patch)
      }
    }
    return { count: changes.length, changes, ackUserRevision }
  }

  function applyAssistantRoundDraft(sid, proposal, a) {
    if (a.authority !== 'rounds' && a.authority !== 'both') return
    const round = isObject(proposal.round) ? proposal.round : {}
    const status = ['continue', 'complete', 'blocked'].includes(String(round.status)) ? String(round.status) : 'continue'
    const bits = [`建议状态：${status}`]
    if (typeof round.summary === 'string' && round.summary.trim()) bits.push(`摘要：${text(round.summary, 240)}`)
    if (Array.isArray(round.evidence) && round.evidence.length) bits.push(`证据：${round.evidence.slice(0, 4).map((e) => String(e).slice(0, 120)).join('；')}`)
    if (Array.isArray(round.nextSteps) && round.nextSteps.length) bits.push(`下一步：${round.nextSteps.slice(0, 4).map((e) => String(e).slice(0, 120)).join('；')}`)
    if (status === 'blocked' && typeof round.blocker === 'string' && round.blocker.trim()) bits.push(`阻塞：${text(round.blocker, 240)}`)
    const o = obsOf(sid)
    o.roundDraft = bits.join(' · ').slice(0, 400)
  }

  async function maybeAskAssistant(sid, at) {
    const a = liveAssistant()
    if (!assistantReady() || !boardHasWork(sid)) return
    const o = obsOf(sid)
    if (!modelIsLate(sid, at) && o.stepsSinceBoard < cfg.observer.maxIdleSteps) return
    if (at - o.lastAssistantAt < Number(a.minIntervalMs || 0)) return
    if (o.assistantCalls >= Number(a.maxCallsPerTurn || 1)) return
    const state = states.get(sid)
    if (!state) return
    o.assistantCalls += 1
    o.lastAssistantAt = at
    const lastOutput = o.outputs[o.outputs.length - 1]
    const files = Array.isArray(o.files) ? o.files.slice(-4).map((f) => f.path) : []
    const lines = [
      `目标：${state.goal && state.goal.phase === 'active' ? JSON.stringify(state.goal.objective) : '(无)'}`,
      ...renderChecklist(state, cfg.observer.maxItems),
      lastOutput ? `最近输出：${lastOutput.text}` : '最近输出：—',
      o.tools.length ? `最近动作：${o.tools.slice(-cfg.observer.maxTools).map((x) => x.name).join(' → ')}` : '最近动作：—',
      files.length ? `最近改动：${files.join(' · ')}` : '最近改动：—',
    ]
    try {
      const raw = await callAssistant({ system: ASSISTANT_SYSTEM, user: lines.join('\n'), a })
      const proposal = parseProposal(raw)
      if (!proposal) throw new Error('proposal-unparsable')
      o.assistantError = ''
      o.assistantNote = String(proposal.note || '').slice(0, 200)
      // 轮次草案：写进 observers，供下一次 followup 的 <progress_goal_round> 拼入。
      applyAssistantRoundDraft(sid, proposal, a)
      // 槽位管理：护栏后落地，每项 updatedBy='assistant'（applyChanges 用 origin 保证）。
      if (a.autoApply !== false && (a.authority === 'slots' || a.authority === 'both')) {
        const g = applyAssistantSlotChanges(state, sid, proposal, a)
        if (g.count > 0) await applyChanges({ sessionId: sid, changes: g.changes, origin: 'assistant', ackUserRevision: g.ackUserRevision })
      }
    } catch (err) {
      o.assistantError = err instanceof Error ? err.message : String(err)
    }
  }

  function renderChecklist(state, maxItems) {
    const items = state.items.slice().sort((a, b) => a.order - b.order)
    const marks = { done: '[x]', doing: '[~]', blocked: '[!]', todo: '[ ]' }
    const lines = items.slice(0, maxItems).map((item) => {
      const bits = [`${marks[item.status] || '[ ]'} ${item.title}（${item.percent}%）`]
      if (item.status === 'doing' && item.current) {
        // 观察者自补的 current 标注待确认：模型不能把事实刷新闻当状态已同步
        const mark = item.current.startsWith('自动同步：') ? '（观察者补，待确认）' : ''
        bits.push(`当前：${item.current}${mark}`)
      }
      if (item.status === 'doing' && item.next) bits.push(`下一步：${item.next}`)
      if (item.status === 'blocked') bits.push(`阻塞：${item.note || '等待中'}`)
      return '- ' + bits.join(' · ')
    })
    if (items.length > maxItems) lines.push(`- …另有 ${items.length - maxItems} 项`)
    return lines
  }

  /**
   * 观察块：每请求重建（systemPrompt.context），不进历史累积。
   * = 清单（checklist）+ 官方 todo 进度 + 最近输出 + 最近动作 +（滞后时）催办。
   * 门控：板启用且还有活干；关板/全完成时不占一行 token。
   */
  function observerContext(sid) {
    if (!cfg.observer.enabled || !isEnabled(sid) || !boardHasWork(sid)) return ''
    const state = states.get(sid)
    const o = obsOf(sid)
    const at = now()
    const lines = []
    lines.push(...renderChecklist(state, cfg.observer.maxItems))
    const t = taskMap.get(sid)
    if (t && t.todoTotal >= 2) {
      const titles = Array.isArray(t.todoItems) ? t.todoItems.slice(0, 4).join('、') : ''
      lines.push(`[官方todo] 完成 ${t.todoDone}/${t.todoTotal}${titles ? '，未完：' + titles : ''}`)
      // 机械对比（算术，非语义）：两套清单完成数漂移 → 让模型自己核对
      const boardDone = state.items.filter((item) => item.status === 'done').length
      if (t.todoDone !== boardDone) {
        // 旧对比行保留（既有 observer 用例断言逐字匹配），新漂移行按 spec 追加。
        lines.push(`对比：官方 todo 完成 ${t.todoDone}/${t.todoTotal} · 板完成 ${boardDone}/${state.items.length}（进度不一致，核对后修正一处）`)
        lines.push(`[todo 漂移] 官方 ${t.todoDone}/${t.todoTotal} · 板 ${boardDone}/${state.items.length}（待裁决）`)
      }
      const mirror = todoMirrorOf(state)
      if (mirror && !mirror.unsupported) lines.push(`[todo 镜像] 已同步 rev=${state.revision} · ${mirror.count} 条`)
    }
    const files = Array.isArray(o.files) ? o.files.slice(-4) : []
    if (files.length) lines.push(`最近改动：${files.map((f) => `${shortPath(f.path)}（${f.tool}）`).join(' · ')}`)
    const lastOutput = o.outputs[o.outputs.length - 1]
    if (lastOutput) lines.push(`最近输出：「${lastOutput.text}」`)
    const tools = o.tools.slice(-cfg.observer.maxTools)
    if (tools.length) lines.push(`最近动作：${tools.map((x) => x.name).join(' → ')}`)
    const synced = o.stepsSinceModel > 0 ? `${o.stepsSinceModel} 步前` : '本回合'
    const late = modelIsLate(sid, at)
    if (late) {
      const idleMin = Math.max(0, Math.round((at - o.lastModelAt) / 60000))
      lines.push(`⚠ 进度已滞后（${synced}${idleMin >= 1 ? '，' + idleMin + ' 分钟' : ''}）：先调用 progress_update 同步再继续；无变化就传 changes=[]。观察者已用最近动作自动刷新 current（updatedBy=observer），但状态/百分比仍需你确认。`)
    }
    if (o.assistantNote) lines.push(`助手审查：${o.assistantNote}`)
    if (o.roundDraft) lines.push(`助手轮次草案（仅供参考）：${o.roundDraft}`)
    if (o.assistantError) lines.push(`助手审查失败：${o.assistantError}（仅影响审查建议，不阻断主流程）`)
    return `<progress-observer revision="${state.revision}" synced="${synced}">\n${lines.join('\n')}\n</progress-observer>`
  }

  // 鲸程文件上报协议：仅 board 关闭的会话注入（开板会话 progress_update 是唯一写通道）。
  function protocolText(sid) {
    const who = String(sid || '')
    return '执行任务时维护**你自己的**进度文件 $DSH_HOME/dsh-progress/<你的会话id>.json（目录不存在就建；文件名就用会话 id，例如 $DSH_HOME/dsh-progress/' + (who || 'session-xxx') + '.json）。⚠️**千万不要写 $DSH_HOME/dsh-progress.json 那个单文件**——那里是所有会话共用的旧位置，谁写谁覆盖，会把别人的任务条顶掉。开工第一步写 {"task":"总结性任务名","session":"' + who + '","stages":["阶段1",...],"current":0,"pct":10,"action":"正在…","etaMin":N,"status":"running","startedAt":毫秒,"updatedAt":毫秒}；session 必须原样填当前会话 id（插件据此把你这条上报合并到本会话的任务上，避免同一任务显示两条）。' +
      '⚠️**每完成一个可交付的小步就更新** current/pct/action/etaMin/updatedAt，不要只在阶段边界更新；**任何单步预计超过 60 秒的，先在 action 里写清"正在做什么（第 N/M 个）"再去做**，做完立刻更新一次。action 要写具体动作（如"渲染第 7/24 张"），不要写"处理中/排队中"这类空话。' +
      '⚠️遇到报错、等待用户确认、卡住不动时，立刻写 {"status":"blocked","issue":"一句话说清卡在哪","updatedAt":毫秒}，恢复后改回 status:"running"；插件会把 blocked 显示成橙色并展示 issue，用户就不会以为还在跑。' +
      '任务真正结束才标 {"status":"done","pct":100,"endedAt":毫秒}。ETA 按阶段数×复杂度推算并在回复中说明依据，简单任务≤3分钟。'
  }

  const hookedAgents = new WeakSet()
  function installAgentHook(agent) {
    if (!agent || !agent.id || !agent.ctx) return
    if (hookedAgents.has(agent)) return
    hookedAgents.add(agent)
    agentOfSession.set(sessionOfAgent(agent), agent)
    try {
      agent.ctx.on('agent/pre-step', async (payload, next) => {
        const sid = String(agent.session?.id ?? agent.id)
        const stepMessages = ((payload && payload.messages) || [])

        // /progress-goal 身份栅栏：目标续轮消息必须精确匹配 attempt，否则拒绝本步。
        const goalRound = stepMessages.find((m) => isGoalRoundMessage(m))
        if (goalRound) {
          const ds = driveStateFor(agent)
          const attempt = ds.attempt
          const src = goalRound.source
          const current = states.get(sid)
          const g = current && current.goal
          const valid = Boolean(
            attempt && sameGoalSource(goalRound, attempt) && !attempt.stale &&
            g && g.id === src.goalId && g.phase === 'active' && g.activation === 'armed' &&
            src.round === g.roundsStarted && src.round === attempt.round
          )
          if (!valid) {
            if (attempt && attempt.goalId === src.goalId) { attempt.stale = true; ds.attempt = undefined }
            return { kind: 'reject' }
          }
          attempt.phase = 'claimed'
        }

        const decision = await next()
        try {
          if (!cfg.protocolHint) return decision
          // /progress-goal 续轮消息绝不注入协议消息：避免重蹈 /goal 身份污染覆辙。
          if (stepMessages.some((m) => isGoalRoundMessage(m))) return decision
          // 单协议收敛：本会话板已启用 → 不再注入文件上报协议。
          if (isEnabled(sid)) return decision
          if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
          const freshUser = stepMessages.find((m) => m && m.source && m.source.kind === 'user')
          if (!freshUser) return decision
          decision.messages.push({
            id: 'dpg-' + now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
            role: 'user',
            content: [{ type: 'text', text: protocolText(agent.id) }],
            // session format v4 拒收旧 {kind:'plugin'} 包装：第三方必须用 producer-owned kind。
            source: { kind: 'plugin:dsh-progress-union', form: 'notice', summary: '任务进度上报协议' },
          })
          return decision
        } catch (_err) {
          return decision
        }
      })
    } catch (_err) {}
  }

  // ==========================================================================
  // C. 时间引擎（widget fork；派生态与 board states 按 sessionId 并联）
  // ==========================================================================

  function sessionOfAgent(agent) {
    return String(agent.session?.id ?? agent.id ?? 'default')
  }

  // 子智能体识别：delegationDepth>0 即子会话；parentSession 存在才采用，拿不到不硬猜。
  function markLineage(task, session) {
    try {
      const hd = session && session.header
      if (!hd || !task) return
      if (typeof hd.delegationDepth === 'number' && hd.delegationDepth > 0) task.isSub = true
      if (task.isSub && hd.parentSession) task.parentId = String(hd.parentSession)
    } catch (_err) {}
  }

  function subTitleOf(task, text) {
    if (task && task.subLabel) return task.subLabel
    return summarizeSubTitle(text)
  }

  function taskOf(sid) {
    let t = taskMap.get(sid)
    if (!t) {
      t = {
        active: false, open: false, title: '', project: '', startedAt: 0, steps: 0,
        lastActivityAt: 0, sid, isSub: false, parentId: '', subLabel: '', subTitled: false,
        _stepTimes: [], todoDone: 0, todoTotal: 0, etaSmooth: 0,
      }
      taskMap.set(sid, t)
      enforceCapacity(sid)
    }
    return t
  }

  function endTask(sid) {
    const t = taskMap.get(sid)
    if (!t || !t.active) return
    t.active = false
    const ended = now()
    // 学一条真实样本：某 step 发生时刻离任务结束还有多久（本机自校正 ETA 的原料）。
    try {
      if (Array.isArray(t._stepTimes) && t._stepTimes.length) {
        const rows = []
        t._stepTimes.forEach((at, i) => {
          const remainSec = (ended - at) / 1000
          if (remainSec > 0 && remainSec < 7200) rows.push({ s: i + 1, r: Math.round(remainSec) })
        })
        recordSamples(rows)
        flushStats()
      }
    } catch (_err) {}
    t._stepTimes = []
    doneList.push({ title: t.title, project: t.project, startedAt: t.startedAt, endedAt: ended, at: ended })
    doneList = doneList.filter((d) => ended - d.at < cfg.doneKeepMs)
    enforceCapacity(sid)
  }

  // 淘汰"最久没有活动"的会话（不能删最早插入的，长会话会被误删）。
  function enforceCapacity(skipSid) {
    if (taskMap.size <= cfg.maxTasks) return
    let victim = null
    let oldestAt = Infinity
    for (const [otherSid, other] of taskMap) {
      if (otherSid === skipSid) continue
      const at = Number(other.lastActivityAt) || 0
      if (at < oldestAt) {
        oldestAt = at
        victim = otherSid
      }
    }
    if (victim) taskMap.delete(victim)
  }

  /**
   * ETA 计算（board 档优先）。纯函数按 (task, items, now) 求值；
   * `smoothing=true` 只走展示通道（会原地推进 etaSmooth），锚点读接口用
   * `smoothing=false`——保证同 (revision, steps, now) 同字节。
   */
  function computeEta(t, boardItems, atMs, smoothing) {
    const startedAt = t && Number(t.startedAt) ? Number(t.startedAt) : 0
    const elapsedSec = startedAt > 0 ? Math.max(0, (atMs - startedAt) / 1000) : 0
    let prior = null
    let etaSrc = 'prior'

    const boardActive = Array.isArray(boardItems) && boardItems.length >= 2
    let boardDone = 0
    let boardLeft = 0
    if (boardActive) {
      for (const item of boardItems) {
        if (item.status === 'done') boardDone += 1
        else if (item.status !== 'blocked') boardLeft += 1 // blocked 不计剩余：它在等人，不是等时间
      }
    }
    const todoTotal = t ? Number(t.todoTotal) || 0 : 0
    const todoDone = t ? Number(t.todoDone) || 0 : 0

    if (boardActive && boardDone >= 1 && elapsedSec > 0) {
      const perItemSec = elapsedSec / boardDone
      prior = { p50: Math.max(10, perItemSec * boardLeft), p75: Math.max(30, perItemSec * boardLeft * 2.2) }
      etaSrc = 'board'
    } else if (todoTotal >= 2 && todoDone >= 1 && elapsedSec > 0) {
      const perItemSec = elapsedSec / todoDone
      prior = { p50: Math.max(10, perItemSec * (todoTotal - todoDone)), p75: Math.max(30, perItemSec * (todoTotal - todoDone) * 2.2) }
      etaSrc = 'todo'
    } else {
      const steps = t ? Number(t.steps) || 0 : 0
      const learned = learnedFor(steps)
      prior = learned || priorFor(steps)
      etaSrc = learned ? 'local' : 'prior'
    }

    const overLimit = Math.min(prior.p75, Math.max(prior.p50 * 1.8, prior.p50 + 60))
    const overSec = elapsedSec - overLimit
    let remainMin
    if (overSec > 30) {
      // 超过这类任务 P75 → 报负数"已超预估"，不假装还剩几秒。
      remainMin = -Math.max(1, Math.round(overSec / 60))
    } else {
      remainMin = Math.max(5, prior.p50 - elapsedSec * 0.6) / 60
    }
    if (smoothing && t) {
      const prev = Number(t.etaSmooth)
      t.etaSmooth = isFinite(prev) && prev !== 0 ? prev + (remainMin - prev) * 0.35 : remainMin
      if (Math.abs(t.etaSmooth - remainMin) < 0.03) t.etaSmooth = remainMin
      remainMin = t.etaSmooth
    }
    return {
      elapsedSec: Math.round(elapsedSec),
      etaMin: Math.max(0, Math.round(remainMin)),
      etaBasis: etaSrc,
      etaP75Min: Math.round(prior.p75 / 60),
      overMin: overSec > 30 ? Math.max(1, Math.round(overSec / 60)) : 0,
    }
  }

  function staleOf(sessionId, atMs) {
    // stale 判定：板在场以 board.updatedAt 为主，否则以自动层 lastActivityAt 为备。
    const state = states.get(sessionId)
    const t = taskMap.get(sessionId)
    let ref = 0
    if (state && state.enabled && state.items.length > 0) ref = Number(state.updatedAt) || 0
    else if (t && t.active) ref = Number(t.lastActivityAt) || 0
    if (!ref) return 0
    const gap = atMs - ref
    return gap > FILE_STALE_MS ? Math.max(1, Math.round(gap / 60000)) : 0
  }

  // 自动层单任务展示载荷：board 开且有 items 时阶段/百分比取板事实，关板退回鲸程旧行为。
  function autoTaskPayload(t, atMs) {
    const state = states.get(t.sid)
    const boardItems = state && state.enabled && state.items.length > 0
      ? state.items.slice().sort((a, b) => a.order - b.order)
      : null
    const eta = computeEta(t, boardItems, atMs, true)
    let stages
    let current = 0
    let pct = 0
    let action = ''
    let autoStage = true
    if (boardItems) {
      stages = boardItems.map((item) => item.title)
      const doingIndex = boardItems.findIndex((item) => item.status === 'doing')
      const firstOpen = boardItems.findIndex((item) => item.status !== 'done')
      current = doingIndex >= 0 ? doingIndex : firstOpen >= 0 ? firstOpen : Math.max(0, stages.length - 1)
      pct = summarize(boardItems).percent
      const doingItem = doingIndex >= 0 ? boardItems[doingIndex] : null
      action = doingItem ? doingItem.current || '' : ''
      autoStage = false
    } else {
      stages = guessStages(t.title)
      const total = Math.max(1, stages.length)
      current = Math.min(total - 1, Math.floor(t.steps / 3))
      pct = Math.min(100, Math.round(((t.steps % 3) / 3) * 100))
    }
    return {
      id: t.sid || '',
      isSub: !!t.isSub,
      parentId: t.parentId || '',
      task: t.title,
      project: t.project,
      stages,
      current,
      pct,
      action,
      etaMin: eta.etaMin,
      status: 'running',
      steps: t.steps,
      auto: true,
      autoStage,
      boardDriven: !autoStage,
      startedAt: t.startedAt,
      updatedAt: t.lastActivityAt,
      etaBasis: eta.etaBasis,
      etaP75Min: eta.etaP75Min,
      overMin: eta.overMin,
      todoDone: t.todoDone || 0,
      todoTotal: t.todoTotal || 0,
      staleMin: staleOf(t.sid, atMs),
      elapsedSec: eta.elapsedSec,
    }
  }

  function latestActiveTask() {
    let latest = null
    for (const [, t] of taskMap) {
      if (!t.active) continue
      if (!latest || t.lastActivityAt >= latest.lastActivityAt) latest = t
    }
    return latest
  }

  function activeCount() {
    let n = 0
    for (const [, t] of taskMap) if (t.active) n += 1
    return n
  }

  function listActiveTasks() {
    const atMs = now()
    const out = []
    for (const [, t] of taskMap) {
      if (!t.active) continue
      const p = autoTaskPayload(t, atMs)
      p.id = p.id || String(t.sid)
      p.activeCount = activeCount()
      out.push(p)
    }
    // 鲸程兼容层：board 关闭的会话若有文件上报任务，合并/独立成条（blocked 也要显示）。
    const reportsByKey = new Map()
    for (const rep of readFileTasks()) {
      const key = String(rep.reportId || 'legacy')
      const prev = reportsByKey.get(key)
      if (!prev || (Number(rep.updatedAt) || 0) >= (Number(prev.updatedAt) || 0)) reportsByKey.set(key, rep)
    }
    for (const fileTask of reportsByKey.values()) {
      const fileStatus = String(fileTask.status || '')
      if (fileStatus !== 'running' && fileStatus !== 'blocked') continue
      const owner = out.find((x) => x.id === String(fileTask.session || ''))
      if (owner && !isEnabled(owner.id)) {
        out[out.indexOf(owner)] = {
          ...owner,
          task: fileTask.task || owner.task,
          stages: Array.isArray(fileTask.stages) && fileTask.stages.length ? fileTask.stages : owner.stages,
          current: Number(fileTask.current) || 0,
          pct: Number(fileTask.pct) || 0,
          action: fileTask.action || '',
          etaMin: Math.max(0, Number(fileTask.etaMin) || 0),
          status: fileStatus,
          issue: fileStatus === 'blocked' ? String(fileTask.issue || '') : '',
          auto: false,
          autoStage: false,
          updatedAt: Math.max(Number(owner.updatedAt) || 0, Number(fileTask.updatedAt) || 0),
        }
      } else if (!owner) {
        out.push({
          ...fileTask,
          id: 'file:' + String(fileTask.reportId || 'legacy'),
          fileSource: fileTask.source || 'legacy',
          auto: false,
          steps: 0,
          activeCount: activeCount(),
          status: fileStatus,
          issue: fileStatus === 'blocked' ? String(fileTask.issue || '') : '',
          startedAt: Number(fileTask.startedAt) || atMs,
        })
      }
    }
    out.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    return out
  }

  function buildTask() {
    const list = listActiveTasks()
    const reported = list.find((t) => t.auto === false && t.isSub !== true) || list.find((t) => t.auto === false)
    if (reported) return { ...reported, activeCount: activeCount() }
    const mainTask = list.find((t) => t.isSub !== true)
    if (mainTask) return { ...mainTask, activeCount: activeCount() }
    if (list.length) return { ...list[0], activeCount: activeCount() }
    if (doneList.length) {
      const d = doneList[doneList.length - 1]
      if (now() - d.at < cfg.doneKeepMs) {
        return {
          task: d.title, project: d.project, stages: [], current: 0, pct: 100,
          action: '', etaMin: 0, status: 'done', steps: 0, auto: true,
          startedAt: d.startedAt, endedAt: d.endedAt, updatedAt: d.endedAt, activeCount: 0,
        }
      }
    }
    return null
  }

  const disposers = []
  try {
    disposers.push(ctx.on('agent/created', ({ agent }) => installAgentHook(agent)))
  } catch (_err) {}
  for (const agent of agents?.list?.() ?? []) installAgentHook(agent)

  // /progress-goal：任何非本域的新消息进入 inbox 视为用户抢占 → 标记 attempt stale 并暂停目标。
  try {
    disposers.push(ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (!agent) return
      const ds = driveStateFor(agent)
      const attempt = ds.attempt
      if (!attempt) return
      if (sameGoalSource(message, attempt)) return // 自己派发的轮次不算竞争
      const src = message && message.source
      if (src && src.kind === GOAL_SOURCE_KIND) return
      // 用户/他人的新消息 → 抢占：暂停目标，清 attempt（等用户下一次明确 resume 或继续）
      attempt.stale = true
      ds.attempt = undefined
      try {
        const sid = String(agent.session?.id ?? agent.id)
        const g = ensureState(sid).goal
        if (g.phase === 'active') {
          g.phase = 'paused'
          g.activation = 'disarmed'
          g.currentRound = 0
          void saveGoal(sid)
        }
      } catch (_err) {}
    }))
    disposers.push(ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      if (!agent) return
      const attempt = driveStateFor(agent).attempt
      if (attempt && sameGoalSource(message, attempt)) attempt.phase = 'claimed'
    }))
    disposers.push(ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      if (!agent) return
      const attempt = driveStateFor(agent).attempt
      if (attempt && sameGoalSource(message, attempt)) {
        attempt.stale = true
        driveStateFor(agent).attempt = undefined
      }
    }))
    disposers.push(ctx.on('agent/disposed', ({ agent }) => {
      const ds = goalDrives.get(agent)
      if (ds) ds.stopping = true
    }))
  } catch (_err) {}

  disposers.push(ctx.on('session/event', (session, event) => {
    try {
      if (!event) return
      const sid = session && session.id ? String(session.id) : 'default'
      const type = event.type
      // 观察者原料：最近输出（assistant/message）与最近动作（tool/call）都是会话事实
      if (type === 'tool/call') {
        recordTool(sid, event.data)
        return
      }
      if (type === 'assistant/message') {
        recordOutput(sid, event.data)
        return
      }
      if (type === 'subagent/descriptor') {
        const dd = event.data || {}
        const label = dd && typeof dd.label === 'string' ? dd.label.trim() : ''
        if (label) {
          const sub = taskOf(sid)
          sub.subLabel = label
          sub.isSub = true
          markLineage(sub, session)
          if (sub.active) {
            sub.title = label
            sub.lastActivityAt = now()
          }
        }
        return
      }
      if (type === 'todo/write' || type === 'todo/update') {
        const td = event.data || {}
        const todos = Array.isArray(td.todos) ? td.todos : []
        if (todos.length) {
          const tk = taskOf(sid)
          let done = 0
          for (const it of todos) {
            const st = it && it.status ? String(it.status) : ''
            if (st === 'completed') done += 1
          }
          tk.todoDone = done
          tk.todoTotal = todos.length
          tk.todoItems = todos
            .filter((it) => it && String(it.status || '') !== 'completed')
            .map((it) => String(it.content || ''))
            .filter(Boolean)
            .slice(0, 8)
          tk.lastActivityAt = now()
          // 回环识别：自家镜像写入（hash 命中）只更新 ETA 原料，不触发裁决。
          const mirror = todoMirrorOf(states.get(sid))
          const incomingHash = hashTodos(todos)
          if (!mirror || mirror.unsupported || incomingHash !== mirror.hash) {
            void maybeReconcileTodo(sid, todos, incomingHash)
          }
        }
        return
      }
      if (type === 'user/message') {
        const d = event.data
        const src = d && d.source
        if (src && src.kind === 'user') {
          const t = textOf(d)
          if (t) {
            userTextMap.set(sid, t)
            const task = taskMap.get(sid)
            if (task && task.active) {
              markLineage(task, session)
              if (task.isSub) {
                // 子任务只在第一条任务描述时命名，后续追问不改名。
                if (!task.subTitled) {
                  task.title = subTitleOf(task, t)
                  task.subTitled = true
                }
              } else {
                task.title = summarizeTitle(t)
              }
              task.lastActivityAt = now()
            }
          }
        }
        return
      }
      if (type === 'turn/start') {
        reconcileCallsThisTurn.set(sid, 0)
        const task = taskOf(sid)
        markLineage(task, session)
        const pendingText = userTextMap.get(sid) || ''
        task.open = true
        // 辅助 LLM 的每回合配额：开新回合重置（轮次草案不跨回合复用）
        obsOf(sid).assistantCalls = 0
        obsOf(sid).roundDraft = ''
        if (!task.active) {
          task.active = true
          task.startedAt = now()
          task.steps = 0
          task._stepTimes = []
          task.todoDone = 0
          task.todoTotal = 0
          task.etaSmooth = 0
          task.lastActivityAt = now()
          task.title = pendingText ? (task.isSub ? subTitleOf(task, pendingText) : summarizeTitle(pendingText)) : '处理中'
          if (task.isSub && pendingText) task.subTitled = true
          task.project = ''
          try {
            const cwd = session && session.header && session.header.cwd ? String(session.header.cwd) : ''
            if (cwd) task.project = path.basename(cwd)
          } catch (_err) {}
        } else {
          task.lastActivityAt = now()
        }
        if (pendingText) userTextMap.delete(sid)
        if (live.status === 'idle') live.status = 'running'
        if (!live.startAt) live.startAt = now()
        live.lastActivityAt = now()
        return
      }
      if (type === 'step/start') {
        // 观察者：距上次写板的步数与周期自动补（无板/全完成时内部直接返回）
        const o = obsOf(sid)
        o.stepsSinceBoard += 1
        o.stepsSinceModel += 1
        maybeAutoSync(sid, now())
        void maybeAskAssistant(sid, now())
        const task = taskMap.get(sid)
        if (task && task.active) {
          task.steps += 1
          if (!Array.isArray(task._stepTimes)) task._stepTimes = []
          task._stepTimes.push(now())
          task.lastActivityAt = now()
        }
        live.steps += 1
        live.lastActivityAt = now()
        if (!live.startAt) live.startAt = now()
        if (live.status === 'idle') live.status = 'running'
        return
      }
      if (type === 'turn/end') {
        const task = taskOf(sid)
        if (task.active) {
          task.open = false
          task.lastActivityAt = now()
          endTask(sid)
        }
        return
      }
    } catch (_err) {}
  }))

  try {
    disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      const st = String(status || 'idle')
      live.status = st
      live.lastActivityAt = now()
      if (st === 'running' && !live.startAt) live.startAt = now()
      if (agent && agent.id && st === 'running') {
        const task = taskMap.get(String(agent.id))
        if (task && task.active) task.lastActivityAt = now()
      }
      // /progress-goal 续轮：agent 空载时自动派发下一轮（用户主动消息会抢占 attempt 而停）。
      if (agent && st === 'idle') {
        requestGoalDrive(agent)
      }
      // idle 不直接结束任务：maintenance 阶段也报 idle，会误杀进行中任务；结束统一走 sweep。
    }))
  } catch (_err) {}

  // 周期兜底：turn 打开但 10 分钟无活动 → 视为卡死结束。
  const sweepTimer = setInterval(() => {
    try {
      const atMs = now()
      for (const [sid, t] of taskMap) {
        if (t.active && t.open === true && atMs - t.lastActivityAt > IDLE_END_MS) endTask(sid)
      }
    } catch (_err) {}
  }, SWEEP_MS)
  if (typeof sweepTimer?.unref === 'function') sweepTimer.unref()

  // ==========================================================================
  // D. progressAnchor 只读锚点面（service + HTTP 双平面，同一 builder）
  //    消费契约（保护区必嵌 / userEdits 硬约束 / rev 对账 / staleMin 标注）见 README。
  // ==========================================================================

  function buildAnchor(sessionId, atMs = now()) {
    const state = states.get(sessionId)
    const t = taskMap.get(sessionId)
    const items = state ? state.items.slice().sort((a, b) => a.order - b.order) : []
    const summary = summarize(items)
    const inFlight = items
      .filter((item) => item.status === 'doing' || item.status === 'blocked')
      .map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        percent: item.percent,
        current: item.current || '',
        next: item.next || '',
      }))
    const pendingChanges = state ? state.userChanges.filter((c) => c.revision > state.agentSeenRevision) : []
    const userEdits = pendingChanges.slice(-20).map((c) => ({
      revision: c.revision,
      at: c.at,
      kind: c.kind,
      itemId: c.itemId,
      title: c.title,
      fields: (c.fields || [])
        .filter((f) => f.field !== 'order')
        .map((f) => ({ field: f.field, from: compactValue(f.from), to: compactValue(f.to) })),
    }))
    // 无在场任务（含 turn/end 后）时时间层给零值 + etaBasis='none'（不给伪 ETA，
    // steps 保留供"上一回合跑了多久"参考）；在场时走纯函数 computeEta
    // (smoothing=false)——同 (revision, steps, now) 必同字节。
    const onAir = Boolean(t && t.startedAt && t.active)
    let time
    if (!onAir) {
      time = {
        startedAt: 0, elapsedSec: 0, steps: t ? Number(t.steps) || 0 : 0, etaMin: 0,
        etaBasis: 'none', etaP75Min: 0, overMin: 0, staleMin: staleOf(sessionId, atMs),
        todoDone: t ? Number(t.todoDone) || 0 : 0, todoTotal: t ? Number(t.todoTotal) || 0 : 0,
      }
    } else {
      const eta = computeEta(t, state && state.enabled && items.length ? items : null, atMs, false)
      time = {
        startedAt: Number(t.startedAt) || 0,
        elapsedSec: eta.elapsedSec,
        steps: Number(t.steps) || 0,
        etaMin: eta.etaMin,
        etaBasis: eta.etaBasis,
        etaP75Min: eta.etaP75Min,
        overMin: eta.overMin,
        staleMin: staleOf(sessionId, atMs),
        todoDone: Number(t.todoDone) || 0,
        todoTotal: Number(t.todoTotal) || 0,
      }
    }
    return {
      version: ANCHOR_VERSION,
      sessionId: String(sessionId || ''),
      revision: state ? state.revision : 0,
      updatedAt: state ? Number(state.updatedAt) || 0 : 0,
      board: {
        enabled: Boolean(state && state.enabled),
        summary,
        inFlight,
        pendingUserChanges: pendingChanges.length,
      },
      time,
      userEdits,
      persistent: Boolean(unit) && !storageError.includes('失败'),
      // 预留位：prime-memory 关闭槽位尾迹扇出（定性方案见 docs/，本轮恒 null）。
      slotTrail: null,
    }
  }

  // —— service 平面（同进程零 I/O；宿主无 provide 面时静默只留 HTTP）——
  const anchorApi = {
    version: ANCHOR_VERSION,
    get(sessionId, atMs) {
      return buildAnchor(String(sessionId || ''), finiteNumber(atMs) ?? now())
    },
    list(atMs) {
      const ids = new Set([...states.keys(), ...taskMap.keys()])
      return [...ids].map((sid) => buildAnchor(sid, finiteNumber(atMs) ?? now()))
    },
  }
  if (typeof ctx.provide === 'function') {
    try {
      const off = ctx.provide('progressAnchor', () => anchorApi)
      if (typeof off === 'function') disposers.push(off)
    } catch (_err) {
      // 宿主 provide 面形状不符：service 平面缺席，HTTP 平面照旧（锚点主出口）。
    }
  }

  // —— sessionProjection 平面：全局多会话聚合（rev 稳定字段；时间字段走 HTTP/service）——
  function aggregateVersion() {
    let v = 0
    for (const s of states.values()) v += s.revision * 2 + (s.enabled === true ? 1 : 0)
    for (const t of taskMap.values()) v += (Number(t.steps) || 0) + (t.active ? 1 : 0)
    return v
  }

  function buildProjectionState() {
    const sessions = []
    for (const [sid, s] of states) {
      const t = taskMap.get(sid)
      const items = s.items.slice().sort((a, b) => a.order - b.order)
      sessions.push({
        sessionId: sid,
        enabled: s.enabled === true,
        revision: s.revision,
        summary: summarize(items),
        pendingUserChanges: s.userChanges.filter((c) => c.revision > s.agentSeenRevision).length,
        steps: t ? Number(t.steps) || 0 : 0,
        startedAt: t ? Number(t.startedAt) || 0 : 0,
        boardUpdatedAt: Number(s.updatedAt) || 0,
      })
    }
    sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    return { version: ANCHOR_VERSION, agg: aggregateVersion(), sessions }
  }

  const projectionParse = (value, what) => {
    if (!isObject(value)) throw new Error(`${what}: 期望普通对象`)
    if (typeof value.version !== 'number' || typeof value.agg !== 'number' || !Array.isArray(value.sessions)) {
      throw new Error(`${what}: version/agg/sessions 形状不符`)
    }
    return value
  }

  ctx.inject(['sessionProjections'], (injected) => {
    const registry = injected && injected.sessionProjections
    if (!registry || typeof registry.register !== 'function') return
    try {
      const definition = {
        key: 'progressAnchor',
        stateSchema: { parse: (v) => projectionParse(v, 'progressAnchor.state') },
        init: () => buildProjectionState(),
        apply: (state) => (aggregateVersion() === state.agg ? state : buildProjectionState()),
        wire: {
          viewSchema: { parse: (v) => projectionParse(v, 'progressAnchor.view') },
          view: (state) => state,
        },
        schema: { parse: (v) => projectionParse(v, 'progressAnchor.view') },
        view: (state) => state,
        stateVersion: 0,
      }
      const off = registry.register(definition)
      if (typeof off === 'function') disposers.push(off)
    } catch (_err) {
      // 投影平面缺席/形状不符：消费方按 capability absence 降级，不影响板与锚点主出口。
    }
  })

  // ==========================================================================
  // E. HTTP 路由（union 主前缀 + board 旧前缀别名一版）
  // ==========================================================================

  const routeDisposers = []

  function sendJson(res, status, body) {
    const textBody = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(textBody),
    })
    res.end(textBody)
  }

  async function readJson(req) {
    let size = 0
    const chunks = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        const error = new Error('请求体过大')
        error.statusCode = 413
        throw error
      }
      chunks.push(chunk)
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch (_error) {
      const error = new Error('请求体不是有效 JSON')
      error.statusCode = 400
      throw error
    }
  }

  function readSessionId(req) {
    const url = new URL(req.url || '/', 'http://localhost')
    const sessionId = url.searchParams.get('sessionId') || ''
    return sessionId && sessionId.length <= 240 ? sessionId : ''
  }

  if (webServer) {
    // 锚点读接口（压缩插件主用；GET 纯只读，零副作用）
    routeDisposers.push(
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_BASE}/anchor`,
        handler: (req, res) => {
          if (req.method !== 'GET') {
            res.writeHead(405, { allow: 'GET' })
            res.end()
            return
          }
          const sessionId = readSessionId(req)
          if (!sessionId) {
            sendJson(res, 400, { ok: false, error: '缺少有效的 sessionId' })
            return
          }
          const url = new URL(req.url || '/', 'http://localhost')
          const atMs = finiteNumber(Number(url.searchParams.get('now'))) ?? now()
          sendJson(res, 200, { ok: true, anchor: buildAnchor(sessionId, atMs) })
        },
      }),
    )

    // 鲸程兼容状态面（悬浮条轮询）
    routeDisposers.push(
      webServer.register({
        kind: 'exact',
        path: WIDGET_STATUS_ROUTE,
        handler: (req, res) => {
          try {
            sendJson(res, 200, {
              ok: true,
              task: buildTask(),
              tasks: listActiveTasks(),
              live,
              activeCount: activeCount(),
              config: { pollMs: cfg.pollMs, doneHoldMs: cfg.doneHoldMs },
            })
          } catch (_err) {
            sendJson(res, 200, { ok: false, task: null, live, activeCount: 0 })
          }
        },
      }),
    )

    // 板路由：union 主前缀 + /progress-board 旧前缀别名（同 handler，保留一版）
    for (const base of [ROUTE_BASE, LEGACY_BASE]) {
      routeDisposers.push(
        webServer.register({
          kind: 'exact',
          path: `${base}/snapshot`,
          handler: (req, res) => {
            if (req.method !== 'GET') {
              res.writeHead(405, { allow: 'GET' })
              res.end()
              return
            }
            const sessionId = readSessionId(req)
            if (!sessionId) {
              sendJson(res, 400, { ok: false, error: '缺少有效的 sessionId' })
              return
            }
            sendJson(res, 200, publicSnapshot(ensureState(sessionId)))
          },
        }),
      )
      routeDisposers.push(
        webServer.register({
          kind: 'exact',
          path: `${base}/action`,
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              res.writeHead(405, { allow: 'POST' })
              res.end()
              return
            }
            if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
              sendJson(res, 415, { ok: false, error: 'content-type 必须是 application/json' })
              return
            }
            try {
              const body = await readJson(req)
              const result = await applyChanges({
                sessionId: body.sessionId,
                changes: body.changes,
                origin: 'user',
                expectedRevision: body.expectedRevision,
                ackUserRevision: undefined,
              })
              sendJson(res, 200, { ok: true, ...result.snapshot, changed: result.changed })
            } catch (error) {
              const status = error && error.statusCode ? error.statusCode : 400
              sendJson(res, status, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
                ...(error && error.snapshot ? { snapshot: error.snapshot } : {}),
              })
            }
          },
        }),
      )
      routeDisposers.push(
        webServer.register({
          kind: 'exact',
          path: `${base}/active`,
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              res.writeHead(405, { allow: 'POST' })
              res.end()
              return
            }
            if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
              sendJson(res, 415, { ok: false, error: 'content-type 必须是 application/json' })
              return
            }
            try {
              const body = await readJson(req)
              const sessionId = body.sessionId
              if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 240) {
                sendJson(res, 400, { ok: false, error: '缺少有效的 sessionId' })
                return
              }
              if (typeof body.active !== 'boolean') {
                sendJson(res, 400, { ok: false, error: 'active 必须是布尔值' })
                return
              }
              const source = body.source === 'command' || body.source === 'user' ? body.source : 'panel'
              if (body.active) {
                setEnabled(sessionId, true)
              } else if (source !== 'panel') {
                // 面板卸载不是用户决定：收起侧栏/切换视图不得静默关掉 agent 工具。
                setEnabled(sessionId, false)
              }
              sendJson(res, 200, { ok: true, enabled: isEnabled(sessionId), source })
            } catch (error) {
              const status = error && error.statusCode ? error.statusCode : 400
              sendJson(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      )
    }
  }

  ctx.effect(() => () => {
    for (const dispose of routeDisposers.splice(0)) dispose()
    if (unit) unit.close().catch(() => {})
  }, 'progress-union: http routes and storage')

  // ==========================================================================
  // F. 工具 / 命令 / 注入绑定（board 照板，命名空间改 union）
  // ==========================================================================

  ctx.effect(
    () =>
      tools.register({
        name: 'progress_update',
        description:
          '维护用户可见进度板。每个用户回合开始时若板为空，先调用本工具建立任务，再执行其他操作。只在子目标完成、状态/百分比实质变化、用户新任务或用户改动时增量更新；只发变化项，不重发整份计划。用户改动处理后传 ackUserRevision；仅确认传 changes=[]。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            changes: {
              type: 'array',
              maxItems: MAX_CHANGES,
              description: '增量补丁；新增不传 id，更新传 id 或精确 title。',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  status: { type: 'string', enum: ['todo', 'doing', 'done', 'blocked'] },
                  percent: { type: 'number', minimum: 0, maximum: 100 },
                  current: { type: 'string' },
                  next: { type: 'string' },
                  approach: { type: 'string' },
                  note: { type: 'string' },
                  remove: { type: 'boolean' },
                },
              },
            },
            ackUserRevision: { type: 'integer', minimum: 0 },
          },
          required: ['changes'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: true,
            properties: {
              ok: { type: 'boolean' },
              revision: { type: 'number' },
              summary: { type: 'object', additionalProperties: true },
              changed: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
          },
          render(_args, value) {
            return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
          },
        },
        async execute(args, exec) {
          const agent = exec.agent
          if (!agent) throw new Error('progress_update 只能在 Agent 会话中调用')
          if (!isObject(args)) throw new Error('参数必须是对象')
          if (!Array.isArray(args.changes)) throw new Error('changes 必须是数组')
          const result = await applyChanges({
            sessionId: agent.session.id,
            changes: args.changes,
            origin: 'agent',
            expectedRevision: args.expectedRevision,
            ackUserRevision: args.ackUserRevision,
          })
          // 拉通道：把"观察"塞进模型本来就必调的那一次调用——inFlight 明细 + 时间面
          const anchor = buildAnchor(agent.session.id, now())
          return {
            ok: true,
            revision: result.snapshot.revision,
            userRevision: result.snapshot.userRevision,
            agentSeenRevision: result.snapshot.agentSeenRevision,
            summary: result.snapshot.summary,
            changed: result.changed,
            inFlight: anchor.board.inFlight.slice(0, 6),
            time: {
              steps: anchor.time.steps,
              elapsedSec: anchor.time.elapsedSec,
              etaMin: anchor.time.etaMin,
              etaBasis: anchor.time.etaBasis,
              staleMin: anchor.time.staleMin,
            },
          }
        },
      }, { when: ({ agent }) => isEnabled(sessionOfAgent(agent)) }),
    'progress-union: agent tool',
  )

  if (commands) {
    ctx.effect(
      () =>
        commands.register({
          name: 'progress',
          description: '启用/关闭进度板工具（默认不加载，避免 token 开销）',
          input: { hint: '[on|off]' },
          handler: ({ agent, rawInput }) => {
            const sessionId = sessionOfAgent(agent)
            const mode = String(rawInput || '').trim().toLowerCase()
            if (mode === 'off') {
              setEnabled(sessionId, false)
              return { kind: 'success', text: '进度板已关闭；Agent 不再加载进度工具，文件上报协议恢复，手动编辑仍会保存。' }
            }
            setEnabled(sessionId, true)
            return {
              kind: 'success',
              text: '进度板已启用；之后在主界面发消息时 Agent 会自动更新，收起侧栏也不会关闭。输入 /progress off 可关闭。',
            }
          },
        }),
      'progress-union: /progress command',
    )
  }

  // —— 模型侧 progress_goal_report 工具（报告轮次状态；助手草案不自动调这里）——
  ctx.effect(
    () =>
      tools.register({
        name: 'progress_goal_report',
        description:
          '在 /progress-goal 续轮里报告本轮状态。complete 需 evidence 且进度板已全部完成；blocked 需 blocker（连续 3 轮同因才落 blocked）；continue 表示仍在推进。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['continue', 'complete', 'blocked'] },
            summary: { type: 'string' },
            evidence: { type: 'array', items: { type: 'string' } },
            nextSteps: { type: 'array', items: { type: 'string' } },
            blocker: { type: 'string' },
          },
          required: ['status'],
        },
        output: {
          schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, goal: { type: 'object', additionalProperties: true } } },
          render(_args, value) {
            return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
          },
        },
        async execute(args, exec) {
          const agent = exec.agent
          if (!agent) throw new Error('progress_goal_report 只能在 Agent 会话中调用')
          if (!isObject(args)) throw new Error('参数必须是对象')
          const view = await applyGoalReport(String(agent.session?.id ?? agent.id), args)
          return { ok: true, goal: view }
        },
      }, { when: ({ agent }) => isEnabled(sessionOfAgent(agent)) }),
    'progress-union: progress_goal_report tool',
  )

  if (commands) {
    ctx.effect(
      () =>
        commands.register({
          name: 'progress-goal',
          description: '设置一个长程目标，自动续轮推进（预算/检查/重试），替代 /goal',
          input: { hint: '[<objective>|status|budget <n>|edit <objective>|pause|resume|clear]' },
          handler: async ({ agent, rawInput }) => {
            const sessionId = sessionOfAgent(agent)
            const raw = String(rawInput || '').trim()
            const lower = raw.toLowerCase()
            try {
              if (lower === 'status' || raw === '') {
                const view = goalView(sessionId)
                return { kind: 'success', text: view.phase === 'idle' ? '没有目标。用法：/progress-goal <objective>' : renderGoalViewText(view) }
              }
              if (lower === 'clear') {
                const current = goalView(sessionId)
                if (current.phase === 'idle') return { kind: 'success', text: '没有目标可清除。' }
                await clearGoal(sessionId)
                return { kind: 'success', text: '目标已清除。' }
              }
              if (lower === 'pause') {
                const view = await pauseGoal(sessionId)
                return { kind: 'success', text: `目标已暂停\n${renderGoalViewText(view)}` }
              }
              if (lower === 'resume') {
                const view = await resumeGoal(sessionId)
                return { kind: 'success', text: `目标已恢复\n${renderGoalViewText(view)}` }
              }
              if (/^budget(?=\s)/i.test(raw)) {
                const value = raw.slice(6).trim()
                const view = await setGoalBudget(sessionId, Number(value))
                return { kind: 'success', text: `预算已更新\n${renderGoalViewText(view)}` }
              }
              if (/^edit(?=\s)/i.test(raw)) {
                const view = await editGoal(sessionId, raw.slice(4).trim())
                return { kind: 'success', text: `目标已更新\n${renderGoalViewText(view)}` }
              }
              // 其余一律当作新目标 objective
              const view = await createGoal(sessionId, raw)
              return { kind: 'success', text: `目标已创建\n${renderGoalViewText(view)}` }
            } catch (err) {
              return { kind: 'error', text: err instanceof Error ? err.message : String(err) }
            }
          },
        }),
      'progress-union: /progress-goal command',
    )
  }

  const agentDisposers = new Map()
  function bindAgentContext(agent) {
    const sessionId = sessionOfAgent(agent)
    if (agentDisposers.has(sessionId)) return
    const dispose = agent.ctx.effect(
      () => {
        const offPolicy = agent.ctx.systemPrompt.section({
          name: 'progress-union-policy',
          order: 520,
          text: () => (isEnabled(sessionId) ? PROGRESS_POLICY : ''),
        })
        const offContext = agent.ctx.systemPrompt.context({
          name: 'progress-union-user-edits',
          order: 60,
          text: () => pendingContext(sessionId),
        })
        const offKickoff = agent.ctx.systemPrompt.context({
          name: 'progress-union-kickoff',
          order: 61,
          text: () => kickoffContext(sessionId),
        })
        // 观察块：清单 + 最近输出/动作 + 滞后催办（每请求重建，不累积）
        const offObserver = agent.ctx.systemPrompt.context({
          name: 'progress-union-observer',
          order: 62,
          text: () => observerContext(sessionId),
        })
        return () => {
          offPolicy()
          offContext()
          offKickoff()
          offObserver()
        }
      },
      'progress-union: prompt policy, user edits and empty-board kickoff',
    )
    agentDisposers.set(sessionId, dispose)
  }

  ctx.effect(() => {
    // 存量 agent 不回放 agent/created：显式绑定，让中途启用的插件也能收到用户改动 diff。
    for (const agent of agents?.list?.() ?? []) bindAgentContext(agent)
    const offCreated = ctx.on('agent/created', ({ agent }) => bindAgentContext(agent))
    const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
      agentOfSession.delete(sessionOfAgent(agent))
      const dispose = agentDisposers.get(sessionOfAgent(agent))
      if (dispose) {
        dispose()
        agentDisposers.delete(sessionOfAgent(agent))
      }
    })
    return () => {
      offCreated()
      offDisposed()
      for (const dispose of agentDisposers.values()) dispose()
      agentDisposers.clear()
    }
  }, 'progress-union: agent contexts')

  ctx.effect(() => () => {
    clearInterval(sweepTimer)
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch (_err) {}
    }
  }, 'progress-union: timers and listeners')

  // 注意：apply 不要 return 任何内省面。cordis 会把 apply 的 resolved value 当 effect
  // 收集，非函数非空即抛 TypeError("Invalid effect")，整条 entry 不激活（宿主只打一行
  // "warning: 1 entry did not activate"，插件页显示异常）。对外面由 progressAnchor
  // service 与 /progress-union/* 路由承担。
}
