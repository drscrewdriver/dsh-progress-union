# 更新日志

本项目的所有值得记录的变更都写在这里。版本号遵循语义化版本。

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
