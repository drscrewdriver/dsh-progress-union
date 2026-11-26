# brief-sidebar 记忆槽位清理扇出 —— 定性方案（本轮不实现）

> 用户裁定：本议题定性记录、单独存档；不改 dsh-prime-memory / dsh-brief-sidebar 任何代码。
> 本原型仅在锚点 `slotTrail` 字段预留位（当前恒 null）。

## 现状

- brief-sidebar 只读消费 prime-memory 的 `memorySlots` 投影（分区默认关——"常驻槽位卡"会把记忆教成常驻物，与相关性召回的定位相悖）。
- prime-memory 侧 done/dropped/expired 尾迹由 `pruneClosedTrail` 有界留存（issue #33：open 数才卡上限，closed 按 `maxClosedTrail` 裁旧），面板按状态徽章全量展示。
- 扇出的真问题：**关闭的槽位语义往哪去**——尾迹裁掉即丢，留着又占展示与额度。

## 三档方案

| 档 | 内容 | 改动面 | 得与失 |
|---|---|---|---|
| A 不扇出 | 尾迹即历史，靠有界裁剪 | 零 | 旧约定语义随裁剪永久丢失 |
| B 展示折叠 | brief-sidebar 把 closed 尾迹折叠为"尾迹 N 条"，点开展开 | 仅投影消费侧 | 界面干净了，语义留存问题没解决 |
| C 后置记忆扇出 | `memory_slot_close` 时把 body/refs 扇出为 L1 记忆记录，尾迹退化为指针；随后 `maxClosedTrail` 可激进缩小 | prime-memory 写路径 | 唯一"既清尾迹又保语义"的路线 |

## 裁定与约束（C 档）

C 可行，挂点已齐：close 是机械写路径（无 LLM）、`refs` 已是指针语义（L1 record_id/路径/URL）、L1 ingest 链路已存在。实施时必须守住：

1. **expireDue 批量过期不逐条扇出**（只批处理或干脆不扇——过期是时间到点，不是"做完了值得记"）；
2. **title 精确去重**，防同槽位重开重关造成 L1 重复记录（对齐 refreshByTitle 的防 churn 思路）；
3. **origin=user 的槽位扇出需过 domain-gate**（用户显式约定 vs 模型顺手记录，入库置信不同）；
4. **扇出失败不阻断 close**（fail-soft，尾迹照留）；
5. 扇出后的槽位 `refs` 追加 L1 record_id，使 brief-sidebar 现有 refViews 深链（`[type] 标题` → 记忆文件）零改动即可跳转——**侧栏不需要为新扇出改代码，这是 C 档优于 B 档的关键**。
6. 配置写面权限不变：扇出属于记忆写路径（受 memoryMutate 语义域），不是外部驱动配置面（用户独占+nonce 那套）。

独立立项进 prime-memory backlog；本原型无代码耦合。
