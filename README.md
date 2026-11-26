# dsh-progress-union

进度结合原型：**board 槽位真相源 × 鲸程时间/ETA 引擎**，并向压缩类插件暴露只读的 **progressAnchor 三层锚点**。

基于（fork，均 MIT）：

- [l3j3y3/dsh-progress-board](https://github.com/l3j3y3/dsh-progress-board) —— 用户可编辑实时进度板（槽位、revision/diff/ack、staleness nudge）
- [uuhihj/task-progress-bar](https://github.com/uuhihj/task-progress-bar)（鲸程 dsh-progress-widget）—— 事件时间引擎（steps/elapsed/ETA 学习链）

## 它解决什么

长程任务被上下文压缩时最容易丢的是"我干到哪了"。本插件把这件事拆成两个正交数据面并统一出口：

- **语义面（board）**：任务槽位 `title/status/percent/current/next`，宿主 KV 持久化，用户面板可改，模型走 `progress_update` 增量补丁——板本体不在上下文里，天然免剪。
- **时间面（widget）**：turn/step 事件计数、已用时长、按"板完成度 > 官方 todo 完成度 > 本机学习分位 > 内置先验"四档推算的剩余时间。

## 给压缩插件的锚点契约（只读）

同一 builder、双平面出口：

- 同进程 service：`ctx.get('progressAnchor').get(sessionId, now?)` / `.list(now?)`
- HTTP：`GET /progress-union/anchor?sessionId=<id>[&now=<ms>]`（`now` 仅供复现/测试）
- UI 投影：`sessionProjections` key `progressAnchor`（多会话聚合，仅 revision 稳定字段；时间字段走上面两个平面）

Schema（version=1，字段名冻结）：

```json
{
  "version": 1, "sessionId": "", "revision": 0, "updatedAt": 0,
  "board": {
    "enabled": true,
    "summary": { "total": 0, "done": 0, "doing": 0, "todo": 0, "blocked": 0, "percent": 0 },
    "inFlight": [ { "id": "", "title": "", "status": "doing", "percent": 0, "current": "", "next": "" } ],
    "pendingUserChanges": 0
  },
  "time": {
    "startedAt": 0, "elapsedSec": 0, "steps": 0, "etaMin": 0,
    "etaBasis": "board|todo|local|prior|none", "etaP75Min": 0, "overMin": 0,
    "staleMin": 0, "todoDone": 0, "todoTotal": 0
  },
  "userEdits": [ { "revision": 0, "at": 0, "kind": "add|edit|remove", "itemId": "", "title": "", "fields": [] } ],
  "persistent": true,
  "slotTrail": null
}
```

压缩时的四条消费规则：

1. **保护区必嵌**：`board`（summary + inFlight）+ `time` 拼成 ~150–200 token 锚点写入压缩摘要；锚点由宿主状态现读重建，历史消息里的旧投影不累积、可整体剪除。
2. **userEdits 是硬约束**：`pendingUserChanges > 0` 时，这些 diff 必须先折叠进摘要或确认已被 ack，**不得随正文剪除**（用户改动优先于模型计划）。已 ack 的旧 diff 完全可剪。
3. **revision 对账可剪**：历史段中 `progress_update` 工具返回的 `revision < anchor.revision` ⇒ 该段状态已兑现于锚点，可安全剪；这为"净收益门槛"类算法提供了确定的被切量与恒定的重建成本。
4. **staleMin / overMin 必须如实转述**：`staleMin > 0` → 摘要注明"真实进度已中断 N 分钟"；`overMin > 0` → "已超预估"。压缩后模型不应把陈旧进行中状态误读为新节奏。

同态保证：同 `(revision, steps, now)` 锚点逐字节相等（无时间戳漂移、无随机），可直接当指纹用。

## 使用

- `/progress`（on）/ `/progress off`：语义与 board 原版一致——开过一次持续启用，收起侧栏不关闭。
- 面板：右侧栏「进度」tab（半开/全面展开/直接编辑）；composer 上方迷你条含 `done/total · 预计剩 N min / 已超预估 / 中断`。
- 单协议收敛：板启用的会话不再注入鲸程的文件上报协议（`progress_update` 是唯一写通道）；板关闭时文件上报层、`$DSH_HOME/dsh-progress/` 读取与 `/dsh-progress/status` 全部按鲸程原行为保留。
- ETA 学习样本沿用鲸程的 `$DSH_HOME/dsh-progress-stats.json`（≥20 条/桶即用本机分位），不迁移不损坏。

## 观察者（辅助主工作模型）

板上还有活干（enabled 且存在未完成项）时，每请求注入一个重建式观察块 `<progress-observer>`（不进历史累积）：

```
<progress-observer revision="7" synced="6 步前">
- [x] 接口改造（100%）
- [~] 补集成测试（40%） · 当前：写 observer 用例 · 下一步：跑全量
- [!] 发版 · 阻塞：等确认
[官方todo] 完成 1/3，未完：补集成测试、发版
对比：官方 todo 完成 2/3 · 板完成 1/3（进度不一致，核对后修正一处）
最近改动：…/src/observer.ts（Edit） · …/test/observer.test.mjs（Write）
最近输出：「接口改造已完成，接下来补测试。」
最近动作：Edit → Bash
⚠ 进度已滞后（6 步前）：先调用 progress_update 同步再继续；无变化就传 changes=[]。
</progress-observer>
```

**事实进输入，判断不进输入**：

- 文件改动只取带 `file_path/path` 类参数的工具调用（同路径去重留最新、上限 4 条）；作业型命令（Bash）不猜它改了哪个文件；
- 清单对比只做算术：官方 todo 完成数 ≠ 板完成数时出一行“进度不一致，核对后修正一处”，不映射“哪个文件对应哪个清单项”（那是模型自己的判断）；
- 观察者自补的 current 在清单行里带 `（观察者补，待确认）`——事实刷新闻不等于状态已同步。

两层"及时更新"：

1. **观察者自补（事实级）**：模型超过 `maxIdleSteps`（默认 6 步）或 `maxIdleMs`（默认 3 分钟）未写板，且最近 3 分钟内有工具调用——自动把 doing 项的 `current` 刷成 `自动同步：<工具名> · <参数摘要>`（`updatedBy=observer`）。**只动 current，不动 status/percent**（语义判断归模型）。
2. **催办（语义级）**：同一滞后条件在观察块里升级为直接指令，模型下一次调用 `changes=[]` 确认即视为已同步（重置计时）。

观察者自己的自动写入不抵消催办——`stepsSinceModel` 只在模型（或用户）写板时重置。空板/全完成/关板时观察块为空串，零 token 开销。

配置（cordis.patch.yml 按实例覆盖）：

```yaml
observer:
  enabled: true
  maxIdleSteps: 6
  maxIdleMs: 180000
  autoSyncCurrent: true
  autoSyncThrottleMs: 60000
  maxItems: 12
  maxOutputs: 2
  maxTools: 3
```

另外 `progress_update` 的返回已补拉通道：`inFlight`（≤6 条 doing/blocked 明细）+ `time`（steps/elapsedSec/etaMin/etaBasis/staleMin）——模型本来就必调的确认调用现在同时就是"观察"。

## 辅助 LLM（审查/监视进度）

观察者默认是**规则版（零 LLM 费用）**。可选的辅助模型会把"清单 + 最近输出 + 最近动作 + 最近改动"交给一个小模型做审查，只让它校准 `current / next / percent`：

```yaml
assistant:
  mode: direct            # '' 关（默认）| 'direct'
  baseUrl: http://127.0.0.1:8000/v1
  model: qwen2.5-3b       # 小模型即可
  apiKey: ''              # 可选；快照只回布尔 hasApiKey
  timeoutMs: 20000
  minIntervalMs: 90000    # 两次审查的最小间隔
  maxCallsPerTurn: 1      # 每回合至多一次
  autoApply: true         # false = 只记录建议不落地
```

- **触发**：板有未完成项，且主模型滞后（`maxIdleSteps`/`maxIdleMs` 超阈值）——与催办/自补同一时机，不额外打扰；
- **硬约束**：只改 `current/next/percent`；不存在的 id 丢弃；**不增删任务、不改 title/status**；每回合配额 + 最小间隔双节流；失败静默（`assistantError` 入观察块，不阻断板与主流程）；
- **产出**：落地项 `updatedBy=assistant`；审查结论一行进观察块：`助手审查：<note>`；
- **端点建议**：优先本地/局域网自建 OpenAI 兼容端点（Ollama、LM Studio、自建 llama.cpp、vLLM、SGLang、Strata、Ninfer 等），也就是面板首区块那条提示的含义；
- 面板侧边栏与全展开两个视图的**第一个内容块**都显示该通道状态（未启用/已启用 + 端点 + 频率），即本插件的"费用提示永远第一"落点。

**为什么不做 host 通道**：union 是纯宿主插件，没有取得宿主 chat 调用的公开面；`direct` 是唯一不靠内部 API 的可靠路径，也正好对应"本地小模型"的推荐用法。

## 明确不做

- 不修改上游两仓库；不改 dsh-prime-memory / dsh-spirit / dsh-brief-sidebar / dsh-context-compression-improved 的任何代码。
- `slotTrail` 恒为 `null`：prime-memory 关闭槽位 → L1 记忆的"后置清理扇出"仅有定性方案（见 `docs/`），字段为未来集成预留。
- 不发 npm；原型验证消费方后再谈发布门禁。

## docs/

- `docs/slot-models-comparison.md` —— 官方 todo / board 槽位 / prime-memory 激活槽位 / spirit 回忆卡 的对比与定性结论
- `docs/slot-trail-fanout.md` —— brief-sidebar 记忆槽位清理扇出的定性方案（A/B/C 三档与裁定）
- `docs/spirit-reference.md` —— spirit 情绪指向 / 流程注入 / 人设槽位的可借鉴处理法在本原型的落点

## 开发与测试

```bash
npm test   # node --test test/*.test.mjs（41 用例，纯 mock ctx，无需宿主进程）
```
