# 消费者指南（给其他插件用）

本文面向**在自己插件里读进度锚点**的开发者：压缩插件、观察面板、状态侧栏、外部脚本等。锚点是**只读**的——它给你"任务干到哪、时间还剩多少、用户改了什么"，不给你写板的能力（写板仍走 `progress_update` / `/progress-union/action`）。

> 依赖：`dsh-progress-union >= 0.4.0`（`./anchor` 子路径与 `subscribe` 自 0.4.0 起提供）。本文所有代码均为 JS（ESM）。

## 0. 先做版本握手，再谈字段

锚点契约有版本号。零依赖的 `./anchor` 子路径导出握手常量与工具，消费方**先比版本，相等才解析字段**；不等就当作不认识、跳过本次数据（不要猜测字段含义，也不要崩）。

```js
import { ANCHOR_VERSION, ANCHOR_ROUTES, isAnchor, anchorLine } from 'dsh-progress-union/anchor'

// ANCHOR_VERSION === 1（当前锚点 schema 版本）
// ANCHOR_ROUTES = { anchor:'/progress-union/anchor', snapshot:'/progress-union/snapshot', status:'/dsh-progress/status' }

function useAnchor(anchor) {
  if (!anchor || anchor.version !== ANCHOR_VERSION) return   // 不认识的版本：跳过
  if (!isAnchor(anchor)) return                              // 形状不对：也跳过
  // ……到这里才安全读 anchor.board / anchor.time / anchor.userEdits
}
```

`isAnchor(v)` 是**宽松形状校验**：只要求 `version` 是数字、`sessionId` 是字符串、`board.enabled` 是布尔、`board.summary` 是对象且 `total/done/percent` 是数字、`time` 是对象；**新增字段不会让它失败**（老快照也能过）。坏数据返回 `false`，用它当第一道闸门即可。

## 1. 三种读法

### 1.1 同进程 service（`ctx.get('progressAnchor')`）

最快、零 I/O。宿主通过 `ctx.provide('progressAnchor')` 提供；**服务可能缺席**（宿主版本旧、provide 面形状不符、插件未按装），此时 `ctx.get('progressAnchor')` 返回空值——**静默降级**，不要抛、不要阻塞自己的插件。

```js
function readAnchors(ctx, sessionId) {
  let service
  try {
    service = ctx.get && ctx.get('progressAnchor')
  } catch (_err) {
    service = null // 取服务本身就失败：当缺席处理
  }
  if (!service || typeof service.get !== 'function') return null // 静默降级

  // 握手：service.version 必须与 ANCHOR_VERSION 相等
  if (service.version !== ANCHOR_VERSION) return null

  const one = service.get(sessionId)     // 同步返回单个锚点对象
  const all = service.list()             // 同步返回锚点数组（多会话聚合）
  // 可选第二参 atMs（复现/测试用）：service.get(sid, atMs) / service.list(atMs)
  return { one, all }
}
```

- `.get(sessionId, atMs?)` / `.list(atMs?)` 都是**同步**返回，不需要 `await`。
- `service.version` 与 `ANCHOR_VERSION` 相等才解析；不等按"不认识"跳过。
- 从未启用过板的会话也会返回合法锚点：`board.enabled === false`、summary 全 0、`time.etaBasis === 'none'`。**这不是错误**。

### 1.2 HTTP（跨进程 / 外部脚本）

三条只读路由（路径常量见 `ANCHOR_ROUTES`）：

| 路由 | 用途 | 返回 |
| --- | --- | --- |
| `GET /progress-union/anchor?sessionId=<id>[&now=<ms>]` | 锚点主出口（压缩插件用） | `{ ok: true, anchor: {…} }` |
| `GET /progress-union/snapshot?sessionId=<id>` | 板快照（槽位明细） | 板的公开快照 |
| `GET /dsh-progress/status` | 鲸程兼容状态面 | `{ ok, task, tasks, live, activeCount, config }` |

- `GET` 纯只读、零副作用；其他方法返回 405。
- `sessionId` 必填且长度 ≤ 240，缺失/非法返回 400。
- `now` 仅供复现/测试；正常消费不要传，让服务端用当前时间。
- 服务缺席（路由未注册）时请求会 404，同样按"读不到就降级"处理。

可照抄的 curl（假设宿主本地端口 `8729`，换成你的实际端口即可）：

```bash
# 锚点主出口（把 <sid> 换成真实 sessionId）
curl -s "http://127.0.0.1:8729/progress-union/anchor?sessionId=<sid>"

# 带 jq 取锚点本体并做版本握手
curl -s "http://127.0.0.1:8729/progress-union/anchor?sessionId=<sid>" \
  | jq -c '.anchor | select(.version == 1)'

# 板快照
curl -s "http://127.0.0.1:8729/progress-union/snapshot?sessionId=<sid>"

# 鲸程状态面
curl -s "http://127.0.0.1:8729/dsh-progress/status"
```

JS 里也可以用导出的路由常量拼 URL，避免硬编码：

```js
import { ANCHOR_ROUTES, ANCHOR_VERSION } from 'dsh-progress-union/anchor'

const res = await fetch(`http://127.0.0.1:8729${ANCHOR_ROUTES.anchor}?sessionId=${encodeURIComponent(sid)}`)
if (!res.ok) return // 降级
const { anchor } = await res.json()
if (!anchor || anchor.version !== ANCHOR_VERSION) return // 握手不过：跳过
```

### 1.3 sessionProjection（键 `progressAnchor`）

插件若已注入宿主的 `sessionProjections` 注册表，可用全局多会话聚合投影，键为 **`progressAnchor`**。它**只含 revision 稳定字段**（`version / agg / sessions[]`，每会话 `sessionId/enabled/revision/summary/pendingUserChanges/steps/startedAt/boardUpdatedAt`）；**时间/ETA 字段不在投影里**，要走上面的 service 或 HTTP 现读。

判脏用 **`agg`**（聚合版本号）：宿主在 `apply(state)` 里比较 `aggregateVersion() === state.agg`，相等返回同引用（不 republish），不等才重建。消费方照此判断即可：

```js
// 伪代码：拿到投影 state 后
if (state.version !== ANCHOR_VERSION) return   // 握手
if (state.agg === lastSeenAgg) return          // 没脏：复用缓存
lastSeenAgg = state.agg
for (const row of state.sessions) {
  // row.revision 变了才需要重新去 service/HTTP 取该会话的完整时间层
}
```

注册表缺席时本插件**静默不注册**，消费方读不到 `progressAnchor` 投影也属正常，按 capability absence 降级即可。

## 2. 订阅变更（0.4.0 新增）

不用轮询：订阅 revision 变化，收到通知再去读锚点。

```js
import { ANCHOR_VERSION } from 'dsh-progress-union/anchor'

let service
try { service = ctx.get('progressAnchor') } catch { service = null }
if (service && service.version === ANCHOR_VERSION && typeof service.subscribe === 'function') {
  const off = service.subscribe(({ sessionId, revision }) => {
    // 板 revision 变了 → 此刻再去读最新锚点
    const anchor = service.get(sessionId)
    // ……处理 anchor
  }, sessionId) // 第二参省略则订阅全部会话

  // 不再需要时务必退订
  // off()
}
```

- 回调参数是 `{ sessionId, revision }`（**只有这两个字段**，不含锚点本体——拿到通知后自行 `get`）。
- **同一 revision 不重复触发**：内部按会话记住上次推送的 revision，重复读/无关事件不会回调。
- 传 `sessionId` 只听该会话；不传（或 `undefined`）听全部会话，返回的 `off()` 会退订该订阅铺开的所有会话。
- **服务缺席静默降级**：`ctx.get('progressAnchor')` 为空、版本不符、或没有 `subscribe` 方法时，不要报错，安静跳过即可。
- 订阅期间板被关掉/会话结束不会再有新 revision；退订后零回调。

## 3. 锚点对象形状（version=1，字段名冻结）

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

- `board.inFlight`：doing/blocked 项的明细（≤6 条），带 `current`/`next`。
- `board.pendingUserChanges` / `userEdits`：未确认的用户改动（最近 20 条），**硬约束**，见下。
- `time.etaMin` / `etaP75Min`：ETA 中位数 / P75（分钟）；`etaBasis` 说明来源（board/todo/local/prior/none）；`overMin` 已超时；`staleMin` 进度中断分钟数。
- `persistent`：板状态是否持久化成功；`slotTrail` 恒为 `null`（预留位）。

## 4. 四条消费规则（压缩/摘要场景尤其重要）

1. **只读不写**：消费方只能 `get/list`/HTTP GET/读投影，绝不代写锚点、板或 official todo。锚点是快照，不是输入面；写板走 `progress_update`，写 todo 由本插件的 `todoSync` 机制负责。
2. **板禁用不是错误**：`board.enabled === false` 是正常的"该会话没开板"状态，summary 全 0、`time.etaBasis === 'none'`；静默按无进度处理，不要报错或注入噪声。
3. **字段缺失按旧版本容忍**：`isAnchor` 只校验必备骨架；新版本可能增加字段，老快照可能没有新字段。用可选链读新增字段（`anchor.time?.etaP75Min`），缺失就当 0/空，不因缺少某个字段判整个锚点非法。
4. **不要缓存 ETA 超过 staleMin**：`staleMin > 0` 表示真实进度已中断 N 分钟，此时 `etaMin` 是基于旧进度的推算，**不要当新节奏沿用**。缓存时间以 `staleMin` 为界——陈旧 ETA 读出来只作"历史参考"，不要拿它给新计划兜底。`overMin > 0` 同理要如实转述"已超预估"。

> 压缩摘要的四条细则（保护区必嵌 / userEdits 硬约束 / revision 对账 / staleMin 标注）见主 [README](../README.md#给压缩插件的锚点契约只读)。

## 5. 单行摘要 `anchorLine`

给状态条、日志、notifier 用的一行文本，形如：

```
45% 3/7 · ETA 6m · stale 12m
```

- 格式：`<percent>% <done>/<total>` + 可选 ` · ETA <n>m`（`etaMin > 0` 才有） + 可选 ` · stale <n>m`（`staleMin > 0` 才有）。
- 值四舍五入为整数分钟；缺值段自动省略；坏形状返回空串 `''`。

```js
import { anchorLine } from 'dsh-progress-union/anchor'

const line = anchorLine(anchor)
// '45% 3/7 · ETA 6m · stale 12m'
// 老快照/无 ETA：'80% 4/5'
// 未启用板：'0% 0/0'
if (line) statusBar.text = line
```

## 6. 快速自检清单

- [ ] 先用 `ANCHOR_VERSION` 握手，不等就跳过
- [ ] 同进程读包在 try/catch 里，服务缺席静默降级
- [ ] HTTP 用 `ANCHOR_ROUTES` 拼路径，`GET` + `sessionId`
- [ ] 多会话用 projection 的 `agg` 判脏，时间字段现读
- [ ] 订阅后 `off()` 退订，同 revision 不重复
- [ ] `board.enabled=false` 当正常状态
- [ ] 新增字段可选链读取，缺失容忍
- [ ] ETA 缓存不超过 `staleMin`
