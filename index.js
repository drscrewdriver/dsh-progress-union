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

// 设置页可见性：宿主 settings.describe() 只看插件导出的 Config（带 .volatile() 的字段
// 才会生成可编辑表单）。导出它，progress-union 才会出现在「设置 → 插件」里，客户端
// scopeOf('progress-union') 也才拿得到命名空间做运行时读写。
export const Config = z.object({
  assistant: z.object({
    mode: z.union(['', 'registered', 'direct']).default(''),
    provider: z.string().default(''),
    model: z.string().default(''),
    baseUrl: z.string().default(''),
    apiKey: z.string().role('secret').default(''),
    authority: z.union(['slots', 'rounds', 'both']).default('both'),
    minIntervalMs: z.number().step(1000).min(0).default(90000),
    autoApply: z.boolean().default(true),
  }).default({}).volatile(),
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

// 辅助 LLM（审查/监视）的 system prompt：只允许"描述现状 + 校准百分比"，禁止增删/改状态。
const ASSISTANT_SYSTEM = 'You are a progress auditor for a task board. Given the board checklist and the recent assistant output / tool activity / file changes, ' +
  'update ONLY per-item current/next/percent so the board matches reality. ' +
  'Never add, remove, retitle, or change the status of an item. ' +
  'Output strictly one JSON object: {"changes":[{"id":"<existing id>","current"?:"...","next"?:"...","percent"?:0-100}],"note":"<one line audit verdict>"}. ' +
  'If nothing needs updating, output {"changes":[],"note":"<why>"}.'

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
function readVolatile(value, fallback) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    const snap = value.get()
    return snap === undefined ? fallback : snap
  }
  return value ?? fallback
}

export async function apply(ctx, config) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, config && typeof config === 'object' ? config : {})
  cfg.observer = Object.assign({}, DEFAULT_CONFIG.observer, cfg.observer && typeof cfg.observer === 'object' ? cfg.observer : {})
  // assistant 是 volatile 字段：保留原始 ref，每次读取时解包（设置面板改了立即生效）。
  const assistantRaw = config && typeof config === 'object' ? config.assistant : undefined
  const unwrappedAssistant = readVolatile(assistantRaw, {})
  cfg.assistant = Object.assign({}, DEFAULT_CONFIG.assistant, unwrappedAssistant && typeof unwrappedAssistant === 'object' ? unwrappedAssistant : {})
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
  // 运行时配置：settings 里的 assistant 覆盖静态 cfg.assistant（面板改了立即生效）。
  function liveAssistant() {
    const section = readAssistantSection()
    const fromSettings = section && isObject(section.value) && isObject(section.value.assistant) ? section.value.assistant : undefined
    return fromSettings ? { ...cfg.assistant, ...fromSettings } : cfg.assistant
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
      // 辅助 LLM（审查/监视）的配置回声：只回非机密字段，apiKey 只回布尔
      assistant: {
        enabled: assistantReady(),
        mode: cfg.assistant.mode || '',
        baseUrl: String(cfg.assistant.baseUrl || ''),
        model: String(cfg.assistant.model || ''),
        hasApiKey: String(cfg.assistant.apiKey || '') !== '',
        minIntervalMs: Number(cfg.assistant.minIntervalMs) || 0,
        autoApply: cfg.assistant.autoApply !== false,
      },
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

  // —— 辅助 LLM（审查/监视）：命题 → 校验 → 落地（只动 current/next/percent）——
  function assistantReady() {
    return cfg.assistant.mode === 'direct'
      && String(cfg.assistant.baseUrl || '').trim() !== ''
      && String(cfg.assistant.model || '').trim() !== ''
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
  async function maybeAskAssistant(sid, at) {
    if (!assistantReady() || !boardHasWork(sid)) return
    const o = obsOf(sid)
    if (!modelIsLate(sid, at) && o.stepsSinceBoard < cfg.observer.maxIdleSteps) return
    if (at - o.lastAssistantAt < cfg.assistant.minIntervalMs) return
    if (o.assistantCalls >= cfg.assistant.maxCallsPerTurn) return
    const state = states.get(sid)
    if (!state) return
    o.assistantCalls += 1
    o.lastAssistantAt = at
    const lastOutput = o.outputs[o.outputs.length - 1]
    const files = Array.isArray(o.files) ? o.files.slice(-4).map((f) => f.path) : []
    const lines = [
      ...renderChecklist(state, cfg.observer.maxItems),
      lastOutput ? `最近输出：${lastOutput.text}` : '最近输出：—',
      o.tools.length ? `最近动作：${o.tools.slice(-cfg.observer.maxTools).map((x) => x.name).join(' → ')}` : '最近动作：—',
      files.length ? `最近改动：${files.join(' · ')}` : '最近改动：—',
    ]
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(2000, Number(cfg.assistant.timeoutMs) || 20000))
    try {
      const base = String(cfg.assistant.baseUrl || '').replace(/\/+$/, '')
      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(String(cfg.assistant.apiKey || '') !== '' ? { authorization: `Bearer ${cfg.assistant.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: cfg.assistant.model,
          temperature: 0,
          max_tokens: 300,
          messages: [
            { role: 'system', content: ASSISTANT_SYSTEM },
            { role: 'user', content: lines.join('\n') },
          ],
        }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      const proposal = parseProposal(body?.choices?.[0]?.message?.content ?? '')
      if (!proposal) throw new Error('proposal-unparsable')
      o.assistantError = ''
      o.assistantNote = String(proposal.note || '').slice(0, 200)
      if (cfg.assistant.autoApply !== false && Array.isArray(proposal.changes) && proposal.changes.length > 0) {
        const byId = new Map(state.items.map((item) => [item.id, item]))
        const changes = []
        for (const candidate of proposal.changes.slice(0, 10)) {
          if (!isObject(candidate)) continue
          const target = byId.get(String(candidate.id || ''))
          if (!target) continue
          const patch = { id: target.id }
          if (typeof candidate.current === 'string') patch.current = candidate.current
          if (typeof candidate.next === 'string') patch.next = candidate.next
          if (typeof candidate.percent === 'number' && Number.isFinite(candidate.percent)) {
            patch.percent = Math.max(0, Math.min(100, Math.round(candidate.percent)))
          }
          if (Object.keys(patch).length > 1) changes.push(patch)
        }
        if (changes.length > 0) {
          await applyChanges({ sessionId: sid, changes, origin: 'assistant' })
        }
      }
    } catch (err) {
      o.assistantError = err instanceof Error ? err.message : String(err)
    } finally {
      clearTimeout(timer)
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
        lines.push(`对比：官方 todo 完成 ${t.todoDone}/${t.todoTotal} · 板完成 ${boardDone}/${state.items.length}（进度不一致，核对后修正一处）`)
      }
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
    try {
      agent.ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        try {
          if (!cfg.protocolHint) return decision
          // 单协议收敛：本会话板已启用 → 不再注入文件上报协议。
          const sid = String(agent.session?.id ?? agent.id)
          if (isEnabled(sid)) return decision
          if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
          const freshUser = ((payload && payload.messages) || []).find((m) => m && m.source && m.source.kind === 'user')
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
        const task = taskOf(sid)
        markLineage(task, session)
        const pendingText = userTextMap.get(sid) || ''
        task.open = true
        // 辅助 LLM 的每回合配额：开新回合重置
        obsOf(sid).assistantCalls = 0
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
