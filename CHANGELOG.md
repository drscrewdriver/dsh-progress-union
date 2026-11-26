# 更新日志

本项目的所有值得记录的变更都写在这里。版本号遵循语义化版本。

## 0.5.0 (2026-11-26)

**plan 文档（spec/tasks/checklist）喂给任务管理 LLM + PTC 通道容错。**

起因：对比 PTC 会话与直调会话，发现「任务文件打勾管理」与「todolist 从任务表转出」都明显弱化。查证后是三个独立缺陷叠成一条链。

- **fix(PTC 容错)**：`applyOneChange` 的 status 支路不再对未知词表抛错。PTC 通道（`run_code` 内 `tools.progress_update`）**不经过工具 JSON Schema**，模型按官方 todo 词表传 `pending` / `in_progress` / `completed` 时会撞上旧版的 `throw new Error('未知状态：pending')`，而 `applyChanges` 是全成全败 —— 一项词表错就让整批 changes 全部丢失（真机会话实测）。
  - 新增 `normalizeStatus()`：22 个别名归一（`pending→todo`、`in_progress|in-progress|running|wip→doing`、`completed|complete→done`、`waiting|failed|stuck→blocked`），大小写与空格容错。
  - 归一失败改为**跳过该字段 + 记 warning**，不再整批失败；新增/编辑两支路行为一致。
  - `applyChanges` 返回值与 `progress_update` 工具 output 新增 `warnings: string[]`，模型下一轮能自己修。
  - **只对 status 宽容**：`remove` 找不到目标、新增缺 title、`percent` 非数字、歧义 title 仍抛错（那些是真 bug，静默会掩盖）。
- **fix(PTC 观察者盲区)**：`session/event` 新增 `tool/ptc-dispatch` 分支。PTC 会话里外层 `tool/call` 只有 `run_code`，内层 `shell`/`read`/`edit`（实测单会话 153 条）全在 `ptc-dispatch` 上——旧版观察者的「最近动作」在 PTC 会话里恒为 `run_code`，助手拿不到任何原料。
  - 只处理终态事件（`dispatch-start` 是起始事件，会重复记）。
  - `recordTool` 增加同 `name+brief` 连续去重（带 `×N` 计数），PTC 一步几十次同名调用不再挤掉窗口。
  - 失败的 dispatch 记 `lastToolError`，观察块新增「最近失败：<name> · <消息>」行。
- **feat(plan 文档接入)**：新增 `planSync` 三档（`off` / **`read`（默认）** / `sync`）与 `plan.*`（`maxFiles` / `maxBytes` / `maxTasks` / `rescanMs` / `echoBack`）。
  - 扫描 `<session.cwd>/.agents/plans/*/`，按 `tasks.md`/`checklist.md` 的 mtime 取最新计划目录；只有 `spec.md` 的计划不进候选（没勾选表可喂）。
  - 新增纯解析器 `parseChecklistMarkdown()`（Phase 分组、`- [ ]`/`- [x]` 两态、`t\d+` id 提取、`✅（验证：…；日期）` 证据尾剥离）与 `parseSpecOutline()`（H1–H3 骨架 + 每节首行）。
  - **观察块**追加一行 `[plan] <slug>：勾选 3/15，当前 Phase 2`（`planSync=off` 时零注入）。
  - **助手输入**追加 `<plan slug="…" file="tasks.md">` 段：勾选计数 + 各 Phase 进度 + 未完项（带 id）+ spec 大纲 —— 这是「让任务管理 LLM 读 plan 文档细化任务板」的主通道。
  - `/progress plan <slug>` 显式绑定、`/progress plan off` 解绑（不存在的 slug 报错并列出候选）；不绑定时按 mtime 自动选，多计划并存时可用 `planSlug` 状态钉住。
  - **`sync` 模式回勾**（默认关）：板项 `done` 且正文命中 tasks.md 中仍为 `- [ ]` 的行 → 改 `- [x]` 并追加 `✅（验证：…；YYYY-MM-DD）`。三层护栏：默认不开、只改仍未被勾选且正文匹配的行、只动勾选态与证据尾（绝不改任务本体）。同一行 10 分钟内不重复回勾。
- **fix(cwd 取错层)**：实测会话事件里 `cwd` 在 **`session` 顶层**，而旧代码读 `session.header.cwd`（恒空）。修正后 `markLineage`（子会话识别）与 `task.project`（项目名）才真正生效；新增 `sessionCwd()` 三路兜底（header.cwd → session.cwd → workspace）。拿不到 cwd 时静默不扫，不猜 `process.cwd()`。
- **fix(上报文件误删)**：`readFileTasks` 的 24h 清理改为「仅当文件声明的 session 不在活跃集合里」才删。旧逻辑只看 mtime，会把常驻会话正在用的任务条顶掉。
- **feat(上报字段)**：`$DSH_HOME/dsh-progress/<sid>.json` 兼容可选 `steps: string[]` 与 `group`（老上报零迁移）。
- 新增 `test/plan.test.mjs`（15 条：解析器 6 + 目录选择 1 + 端到端 8），全量 `npm test` **79/79** 绿。

## 0.4.0 (2026-11-26)

**锚点开放 `./anchor` 子路径与订阅面，附消费者指南。**

- feat(anchor)：新增 `./anchor` 子路径（零依赖导出 `ANCHOR_VERSION` / `ANCHOR_ROUTES` / `BOARD_STATUSES` / `isAnchor` / `anchorLine` 常量、校验与单行摘要）供其他插件握手消费；`progressAnchor` service 新增 `subscribe(listener, sessionId?)` 订阅（回调 `{sessionId, revision}`，同一 revision 去重、退订 `off()`）。
  - 新增 `docs/consumer-guide.md`：三种读法（service / HTTP / sessionProjection）、版本握手、订阅退订、四条消费规则、curl 示例与工具函数用法；README 增「给其他插件用」小节指向该指南。

## 0.3.0 (2026-11-26)

**板变更镜像到官方 todo（可关）+ 助手冲突裁决。**

- feat(todo)：板 → 官方 todo 镜像 + 助手冲突裁决。设置页三段开关 `off` / `mirror` / `reconcile`（默认 **`reconcile`**）——默认从 `mirror` 改为 `reconcile` 属**行为变更**：外部 todo 改动会触发助手裁决，`adopt-todo` 会覆盖模型写的清单，不想要就在设置页关掉或切 `off`；`mirror` 只做板 → todo 单向镜像；`reconcile` 还会据板与最近输出/动作做三选一裁决（adopt-todo / keep-board / merge）。
  - hash 回环防护：自家镜像写入的 todos 由稳定内容哈希识别，命中只更新 ETA 原料、不触发裁决。
  - 200ms 去抖：写板后调度镜像按 `mirrorThrottleMs`（默认 200ms）合并突发变更，避免逐帧写 todo。
  - 助手不可用时只报漂移：无 registered/direct 助手或调用失败/超时/坏 JSON 时，两侧都不改，只在观察块记 `[todo 漂移]` 行，不阻断板与主流程。

## 0.1.8 (2026-11-26)

**修复：registered 通道写错 DSH LLM 契约；配置面搬回宿主设置页。**

- 事故：registered 模式把 system prompt 塞进 `messages[{role:'system'}]`、content 又传裸字符串，而 `llm.stream` 的 `GenerateOptions.system` 才是 adapter 映射到 provider system 槽的字段 → 请求实际没有 system，DeepSeek 回落到内置 “You are a helpful assistant.” 并把它当正文返回，`parseProposal` 失败只剩 `proposal-unparsable`（旧测试把 chunk 桩成 `{content}`，跟着一起错，没能拦住）。
- 修复：改为 `system: ASSISTANT_SYSTEM` + `messages: [{ role: 'user', content: [{ type: 'text', text }] }]`，chunk 只认 `type === 'text-delta'`，`finish.reason` 非 stop/max-tokens 直接报错，空正文报 `assistant-empty`；并透传 `signal`。
- 回归测试：锁定 system 必须在 `options.system`、`messages` 不得出现 `role:system`、content 必须是块数组。
- 设置面：`Config.assistant` 改为**逐叶子 `.volatile()`**（整对象标 volatile 不会生成字段表单——这就是「设置 → 插件」里看不到辅助 LLM 配置的原因）；侧边栏不再放编辑表单，只留只读状态并指向设置页；新增「live ref 逐字段重读」测试。

## 0.1.9 (2026-11-26)

**设置面真正落地：顶层 settings.section + configForms 三组卡片。**

- 上一版只标了 schema 的 volatile，仍无入口——宿主不会凭导出的 `Config` 自动生成表单，设置面必须由**客户端**注册到 `settings.section` 槽（与 dsh-browser-cdp / dsh-spirit 同式）。
- 新增独立分节「进度板」（id `dsh-progress-union`，order 215），卡内三组：
  - 辅助 LLM：mode / provider / model / baseUrl / apiKey / authority / minIntervalMs / autoApply；
  - 观察者：enabled / maxIdleSteps / maxIdleMs / autoSyncCurrent / autoSyncThrottleMs / maxItems；
  - API（只读）：`progressAnchor` service、`/progress-anchor`、`/snapshot`、`/dsh-progress/status` 三条 HTTP。
- 数据臂走宿主原生 `configForms.get(entryId)` 句柄（subscribe / getSnapshot / set，写值带 revision）；宿主无该服务时卡内显示只读提示，不静默丢入口。
- `Config` 增 `protocolHint` 与 `observer.*` 叶子级 volatile；`apply` 对 `cfg.observer` / `cfg.protocolHint` 改用 getter 解包 live ref → 设置页改阈值立即生效。
- 侧边栏保持只读状态行（编辑统一留在设置页，避免两处写同一命名空间）。
- 测试：新增 3 条设置面契约守卫（逐叶子 volatile、外层不标、客户端注册 settings.section + configForms），共 51 用例全绿。

## 0.2.0 (2026-11-26)

**设置面双座位 + 卡片重做（向 browser-cdp / prime-memory 的密度看齐）。**

- 为什么 0.1.9 只"勉强看到"：样式写在数据面板的 `<style>` 里，而设置页是另一个 React 根，样式到不了 → 卡片裸奔、标签与输入框挤成一行。现在改为把样式表注入 `document.head`（id `dsh-progress-union-settings-style`），全命名空间 `.dsu-*` 前缀。
- 双座位：顶层 `settings.section`（独立分节「进度板」）＋ `plugins.bundle.config`（插件详情页卡片，keyed by **包名**）。bundle 页此前是空的，现在与分节共用同一张卡。
- `configForms` 句柄改为 deferred `ctx.inject(['configForms'])` 捕获：该服务可能晚于客户端 apply 就绪，旧写法在那种时序下会永远拿不到写面；现在句柄到位后两个座位自动刷新。
- 卡片结构：可折叠分组卡（标题 + 徽标 + 折叠箭头）／行式 label+control、开关为药丸开关、枚举为分段控件（模式：关闭·已注册·直连；权限：槽位+轮次·仅槽位·仅轮次）、数值带单位后缀（ms / 步 / 项）、底部动作条（保存 / 撤销 / 未保存提示 / 状态）。
- 写入策略：文本与数字走草稿，点「保存」按组一次落盘（避免逐字符写盘）；开关与分段即时落盘（乐观刷新 + 状态回执）。
- 模式为「关闭」时只显示模式行，选中 registered 才出现 provider，选中 direct 才出现 baseUrl/apiKey——不再把互斥字段一起摊开。
- 测试：设置面守卫扩到 8 条断言（双座位、包名 key、configForms、样式注入），共 51 用例全绿。

> 说明：0.1.0 是真实构建产物；0.1.1–0.1.6 由 0.1.0 → 最终态的可核验 diff 按功能块「逻辑分化重建」，每一版都只包含该版本描述的能力，源码逐版可执行；0.1.7 是发布工程面。

## 0.1.7 (2026-11-26)

**发布工程面。**

- 仓库落地：`repository`/`homepage`/`bugs` 指向 GitHub，`publishConfig` 固定 npmjs + public + latest；
- `engines.dsh` 与 `dsh.plugin.json` 对齐（`>=0.2.0-0 <0.3.0-0`），双清单版本同值；
- 包内容纳入 `test/` 与 `CHANGELOG.md`；README 补安装面并移除"不发 npm"表述；
- 测试：47 用例全绿（`node --test test/*.test.mjs`）；代码与 0.1.6 一致，无行为变更。

## 0.1.6 (2026-11-26)

**`/progress-goal` 命令面。**

- `status`/`budget <n>`/`edit <objective>`/`pause`/`resume`/`clear` 六个子命令，其余输入视为新目标；
- 命令只在宿主注册了 `commands` 服务时挂载，缺失则静默降级。

## 0.1.5 (2026-11-26)

**模型侧 `progress_goal_report` 工具。**

- 模型每轮末上报 `continue|complete|blocked`：`complete` 必须给证据且进度板已全 done；`blocked` 需具体 blocker 且连续 3 轮同因才落 phase；
- 助手草案只作建议，绝不自动调用此工具。

## 0.1.4 (2026-11-26)

**助手双通道 + 护栏 + 面板可编辑。**

- `registered` 走宿主 `llm.stream`（复用 Settings→模型里的 provider/model，免密钥）；`direct` 走自建 OpenAI 兼容端点；
- `authority` 三档（slots/rounds/both）+`maxSlotChanges` 护栏：助手可增删改槽位、产出轮次草案，判断权仍归主模型；用户未确认改动优先（先 ack）；
- 面板 `LlmAssistNotice` 升级为可展开编辑器（模式/提供方/模型/端点/密钥/权限/保存），配置写入 settings 命名空间即时生效。

## 0.1.3 (2026-11-26)

**续轮驱动器（重试）。**

- idle 时自动派发下一轮 `followup`，消息带自建 `source.kind`；`pre-step` 身份栅栏精确匹配 attempt/goalId/revision/round，不匹配直接 reject；
- 任何非本域消息进 inbox 视为用户抢占：标记 attempt stale 并暂停目标；
- 轮次草案随 followup 拼入，回合切换时清空，避免跨轮复用。

## 0.1.2 (2026-11-26)

**迷你目标域内核（自建，不复用官方 goals 域）。**

- `goal` 状态机（idle/active/paused/blocked/complete）+ 状态归一化 + 预算 `maxRounds`；
- create/edit/budget/pause/resume/clear 与 `goalView` 播报视图；快照回声新增 `goal` 字段；
- 助手提示词带上当前目标，观察者不再只看到板。

## 0.1.1 (2026-11-26)

**设置面。**

- 导出 `Config`（schemastery），progress-union 出现在「设置 → 插件」，客户端 `scopeOf('progress-union')` 可读写；
- 注入 `settings`/`llm`/`commands`；`.volatile()` 字段支持 live ref（带 `.get()`）解包，面板改了立即生效；
- `DEFAULT_CONFIG.assistant` 扩展（provider/authority/maxSlotChanges），配置回声按 settings 实时值输出。

## 0.1.0 (2026-11-25)

**首个原型。**

- board 槽位真相源（用户可编辑、revision/diff/ack 增量、staleness nudge）；
- 鲸程时间引擎（step 计数、elapsed、ETA 四档 board > todo > local > prior）；
- 只读三层进度锚点 `progressAnchor`（service + HTTP 双平面），供压缩类插件消费。
