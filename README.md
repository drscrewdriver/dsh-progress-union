# dsh-progress-union

进度结合原型：**board 槽位真相源 × 鲸程时间/ETA 引擎**，并向压缩类插件暴露只读的 **progressAnchor 三层锚点**。

基于（fork，均 MIT）：

- [l3j3y3/dsh-progress-board](https://github.com/l3j3y3/dsh-progress-board) —— 用户可编辑实时进度板（槽位、revision/diff/ack、staleness nudge）
- [uuhihj/task-progress-bar](https://github.com/uuhihj/task-progress-bar)（鲸程 dsh-progress-widget）—— 事件时间引擎（steps/elapsed/ETA 学习链）

## 安装

```bash
npm i dsh-progress-union          # 走 npm 版本号
# 或本地开发：pnpm --dir <profile> add file:<repo>/dsh-progress-union-<ver>.tgz
```

装好后在 profile 的 `dsh.profile.bundles` 里挂上 `dsh-progress-union`，重启宿主加载；**配置面有两个入口**：设置页左侧的独立分节「进度板」（与记忆 / 模型 / 插件并列），以及插件详情页（bundle 设置页）里的同名配置卡。两处是同一张卡，经宿主 `configForms` 句柄读写；文本/数字改完点「保存」，开关与分段即时落盘，均无需重启。也可在 profile 的 `cordis.patch.yml` 里写 `config:` 作部署面默认值。

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

### 给其他插件用

上面的契约是"是什么"，**怎么在自己的插件里读/订阅/降级/握手**见 [docs/consumer-guide.md](docs/consumer-guide.md)（三种读法、版本握手、订阅退订、四条消费规则、curl 示例、`isAnchor`/`anchorLine` 用法）。零依赖的 `./anchor` 子路径自 0.4.0 起可用：

```js
import { ANCHOR_VERSION, ANCHOR_ROUTES, isAnchor, anchorLine } from 'dsh-progress-union/anchor'
// ANCHOR_VERSION 握手 · ANCHOR_ROUTES 三条只读路由 · isAnchor 形状校验 · anchorLine 单行摘要（形如 45% 3/7 · ETA 6m · stale 12m）
```

自 **v0.3.0** 起，板变更会镜像到宿主官方 todo（设置页三段开关 `off` / `mirror` / `reconcile`，默认 `reconcile` 会覆盖模型写的清单，属行为变更，可在设置页关掉或切到 `off`）；详见 [CHANGELOG](CHANGELOG.md#030-2026-11-26)。

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

观察者默认是**规则版（零 LLM 费用）**。可选的辅助模型会把"清单 + 最近输出 + 最近动作 + 最近改动"交给一个小模型做审查：

**配置位置：设置 → 进度板**（或插件详情页的同名卡片）。卡内三组可折叠：辅助 LLM / 观察者 / 只读 API；观察者的滞后阈值也在这张卡里。

```yaml
assistant:
  mode: ''                # '' 关（默认）| 'registered' | 'direct'
  provider: local-35b     # registered：Settings→模型 里的 provider 名（走宿主 llm.stream，免密钥）
  model: qwen2.5-3b       # registered/direct 共用的模型 id
  baseUrl: http://127.0.0.1:8000/v1   # direct 专用
  apiKey: ''              # direct 专用；快照只回布尔 hasApiKey
  authority: both         # slots | rounds | both
  minIntervalMs: 90000    # 两次审查的最小间隔
  autoApply: true         # false = 只记录建议不落地
```

- **两条通道**：`registered` 走宿主 `llm.stream`（复用 Settings→模型 里已配好的 provider/model，无需另存密钥；system prompt 走 `options.system`，输入走 `ContentBlock[]`）；`direct` 直连自建 OpenAI 兼容端点；
- **触发**：板有未完成项，且主模型滞后（`maxIdleSteps`/`maxIdleMs` 超阈值）——与催办/自补同一时机，不额外打扰；
- **职责**：按 `authority` 可增删改槽位（≤8 条/次，用户未确认改动优先）并产出轮次草案（仅建议，判断权归主模型）；每回合配额 + 最小间隔双节流；失败静默（`assistantError` 入观察块，不阻断板与主流程）；
- **产出**：落地项 `updatedBy=assistant`；审查结论一行进观察块：`助手审查：<note>`；
- **端点建议**：`direct` 优先本地/局域网自建 OpenAI 兼容端点（Ollama、LM Studio、自建 llama.cpp、vLLM、SGLang、Strata、Ninfer 等）；
- 侧边栏与全展开两个视图的**第一个内容块**只做只读状态展示（未启用/已启用 + 端点 + 频率）并指向设置页，**不再放编辑表单**——配置单挂在宿主设置面，避免两处写同一命名空间。

**为什么不做 host 通道**：union 自身不直接持有宿主 chat 会话；`registered` 只借 `llm.stream` 一次性调用（不走主对话），`direct` 则完全不依赖宿主内部 API，两路都只拿回一段 JSON，不触碰会话历史。

## plan 文档接入（v0.5.0，默认只读）

让**任务管理 LLM 直接读 codeplan 的四件套**（重点 `tasks.md` / `checklist.md`，`spec.md` 取大纲），用它们细化任务板——板上不再是模型凭空编的几条，而是与你的计划表对齐的粒度。

扫描位置：`<会话 cwd>/.agents/plans/<计划名>/`，多个计划并存时按 `tasks.md` 的 mtime 取最新；只有 `spec.md` 的计划不进候选（没有勾选表可喂）。

| `planSync` | 行为 |
|---|---|
| `off` | 完全不读盘，零 token |
| **`read`**（默认） | 观察块出一行 `[plan] slug：勾选 3/15，当前 Phase 2`；助手输入带 `<plan>` 段（勾选计数 + 各 Phase 进度 + 未完项 + spec 大纲）。**不写任何用户文件** |
| `sync` | 在 `read` 基础上，板项 `done` 且正文命中 `tasks.md` 中仍为 `- [ ]` 的行 → 回勾成 `- [x]` 并追加 `✅（验证：…；YYYY-MM-DD）` |

**回勾三层护栏**（写用户文件是高风险动作）：
1. 默认 `read`，`sync` 必须显式开；
2. 只改「当前仍未被勾选」且正文匹配的行——你改过那一行就不动；
3. 只动勾选态与证据尾，**绝不改任务本体**（codeplan 铁律）；同一行 10 分钟内不重复回勾。

显式绑定计划目录（多计划共存时避免选错）：

```
/progress plan manage-session-readonly-star   # 钉住这个计划
/progress plan off                            # 解绑，回到按 mtime 自动选
```

绑了一个不存在的 slug 会报错并列出候选，不会悄悄换成别的计划。

**不做**：解析 `findings.md`（codeplan §2 外部内容隔离区，不进上下文）、把 plan 全文塞 systemPrompt（每请求重建会放大 token）。

## 明确不做

- 不修改上游两仓库；不改 dsh-prime-memory / dsh-spirit / dsh-brief-sidebar / dsh-context-compression-improved 的任何代码。
- `slotTrail` 恒为 `null`：prime-memory 关闭槽位 → L1 记忆的"后置清理扇出"仅有定性方案（见 `docs/`），字段为未来集成预留。
- 发布形态：npm 包 `dsh-progress-union` 自 0.1.0 起逐版打 tag 与 GitHub Release；宿主侧按 npm 版本号安装，不再依赖本地 tgz。

## docs/

- `docs/slot-models-comparison.md` —— 官方 todo / board 槽位 / prime-memory 激活槽位 / spirit 回忆卡 的对比与定性结论
- `docs/slot-trail-fanout.md` —— brief-sidebar 记忆槽位清理扇出的定性方案（A/B/C 三档与裁定）
- `docs/spirit-reference.md` —— spirit 情绪指向 / 流程注入 / 人设槽位的可借鉴处理法在本原型的落点

## 开发与测试

```bash
npm test   # node --test test/*.test.mjs（51 用例，纯 mock ctx，无需宿主进程）
```
