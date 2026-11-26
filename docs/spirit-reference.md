# spirit 槽位处理法的借鉴与落点

> 侦查来源：dsh-spirit `slot/grid.ts`、`slot/bias.ts`、`slot/render.ts`、
> `hooks/card-pre-step.ts`、`hooks/persona-section.ts`。

## spirit 是怎么处理"槽位"的

1. **情绪指向（grid）**：3×3 valence×arousal 网格 → `状态词 + 第一人称行为倾向` 查表。
   不给模型数值（`valence=-0.6` 是噪声），只给能直接执行的话（"句子变短，不想解释第二遍"）；
   极端负面档带 `soft` 降级措辞 + 非医疗声明；`stepToward` 钳制单轮跨格数，防"人格抽动"。
2. **流程记忆注入（renderCard）**：回忆卡是唯一注入出口。多段固定形状 + 固定丢尾优先级
   （状态段永不丢）；预算逐行实测、超了**整段丢不截半句**；卡带声明行（"不是用户发言，
   不覆盖指令"）与签名行（自家文本识别/回声过滤共用单源）；同态输出（无时间戳/随机，
   同输入必同字节）用作指纹判"已发"，两段式记账等卡真进会话日志才生效。
3. **人设槽位（persona-section）**：走 `systemPrompt.section` 而**非 `context()`**——
   context 文本进尾部快照不进系统提示，写错会得到"看似都生效"的静默错位；
   缓存键 = 人格 revision + 命中预设 id + 主人档案 revision + 同步时刻 四元组，
   任一未变才复用字节；disposer 挂插件 fiber 防热重载撞名。
4. **条件化 bias（刀4）**：强负体验短期抑制同类动作——只经卡文本通道，不触 decision/
   不注册守卫/不改系统提示控制面；存储是"可重算派生缓存"，pre-step 只 O(1) 查表禁扫表。

## 本原型的落点

| spirit 做法 | union 落点 | 位置 |
|---|---|---|
| snapshot-replace（后卡取代前卡） | user-edits/kickoff 注入用 producer-owned kind `plugin:dsh-progress-union`；锚点本体不进消息历史，宿主 KV 现读重建 | index.js D/F 段 |
| 同态输出当指纹 | `buildAnchor` 冻结 now 参数后逐字节相等（test/anchor.test.mjs 断言），压缩器可直接拿锚点做"旧投影可剪"判据 | buildAnchor + anchor.test |
| 预算整段丢、不截半句 | `userEdits` 超 20 条整条截断（slice(-20)）、字段值 compact 到 240+…，绝不截断句子中间 | buildAnchor |
| section ≠ context 的实测纠偏 | policy 用 `section(520)`，动态投影用 `context(60/61)`——与 board 原版一致，本表把"为什么"记下来 | bindAgentContext |
| 声明行/免责 | user-edits 注入文本自带"用户改动优先于你的计划、处理完传 ackUserRevision"边界句 | pendingContext |
| 派生缓存不入真源 | 时间引擎 taskMap 纯内存派生；重启后从事件流重新长出来，KV 里只存板事实 | C 段设计 |

## 没抄的两点（有意为之）

- **数值伪精确双闸**：spirit 禁报浮点情绪数值；union 反其道——ETA/staleMin 就是要给数，
  但只在"有真实样本链支撑（board/todo/local）"时给，无依据时 `etaBasis:'none'` 不编造。
- **pre-step 每步注入**：槽位常驻注入按回合去重（TurnInjectGate 思想）留给压缩联动演进；
  union 的注入面只在系统提示重建时生效，不逐 step 追注。
