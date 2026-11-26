# 四种"槽位"模型对比与定性结论

> 侦查来源：deepseek-harness `packages/todo/tool-todo`、l3j3y3/dsh-progress-board、
> dsh-prime-memory（store/slots.ts、hooks/slot-recall.ts、projection/slots.ts）、
> dsh-spirit（slot/grid|bias|render、hooks/card-pre-step|persona-section）。

| 维度 | 官方 todo | board items（本插件语义面） | prime-memory 激活槽位 | spirit 回忆卡 |
|---|---|---|---|---|
| 作用域 | 会话级；`todo/write` 全量快照落会话日志，last-write-wins | 会话级；KV unit `progress_union`，重启恢复 | **全局跨会话**；slots.json + rev RMW 合并 | 派生态不落库为真源；从 experience/ontology 现算 |
| 字段 | `{content, status(pending/in_progress/completed)}`，≤1 个 in_progress | `{title, status(todo/doing/done/blocked), percent, current, next, approach, note, group}` | `{title, kind(rule/todo/anchor/pointer), status(open/done/dropped/expired), priority, body≤512, refs, pinned, validUntil, origin}` | 状态/事务/线程/记着/惦记/反馈/刚刚/想起/暖/开场 分段 |
| 写者 | 模型（整表替换） | 模型增量 patch + **用户面板编辑**（diff+ack 双轨） | 模型工具 + 服务端 refreshByTitle + 面板 | 系统自动（pre-step 组装） |
| 进模型 | 不进上下文，UI 投影 `todos` | 每请求重建三投影（policy/user-edits/kickoff） | pinned&&open 按 priority + 字节预算，`<system-reminder>` 每回合去重，compaction/end 作废重注 | user 尾部 `form:'snapshot'`，后卡取代前卡 |
| 清理 | 下回合 `turn/start` 清空 | 无（板随会话存续） | expireDue 机械过期 + pruneClosedTrail 有界尾迹 | 预算逆序丢尾（状态段永不丢） |

## 定性结论

1. **三层正交，不可混用**：
   - 官方 todo = 回合内工作清单（易失、模型独占、UI 消费）；
   - board 槽位 = 跨压缩任务真相源（用户可编辑、增量协议、锚点出口）；
   - prime-memory 槽位 = 跨会话常驻环境约定（规则/锚点/指针语义，不是进度）；
   - spirit 卡 = 体验投影（情绪与经历，不是任务状态）。
2. 本原型的进度槽位（board×widget）**不应**并入 prime-memory slots：前者会话级高频小改、无 priority/pinned 语义；后者全局低频长效、有字节预算与扇出语义。混用会让"用户改一条网络规则"和"完成一个子任务"走同一条 diff 通道，revision 对账即失效。
3. 压缩器眼中只有两种槽位：**宿主侧现读重建的（免累积）**与**消息历史里沉积的（待剪）**。board/spirit 卡属于前者，todo 工具调用痕迹属于后者——锚点接口的意义就是把后者的状态折叠进前者。
