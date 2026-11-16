# Collie · Ticket 交互

Coordinator 产生输入和判断，Inbox 按状态投影 Ticket。Ticket 是 `Decision + Task + Receipt` 的统一视图，不是新的领域对象。

## 状态过滤

顶部固定为：

```text
All | Needs you | Working | Review | Settled
```

- **Needs you**：等待回答、授权或异常处理。
- **Working**：Coordinator 判断中，或任务正在执行。
- **Review**：Receipt 已就绪，等待验收。
- **Settled**：完成、关闭或失败的历史记录。

Working 内的角标不新增过滤项：

- **Thinking**：输入已写入 Ledger，Coordinator 尚未生成最终 Decision。
- **In progress**：Decision 已生成，herdr-task 正在执行。

## Ticket 引用

点击 Ticket 的“引用”后，在 New / Build 输入框上方出现可移除的 chip。提交时，`collie-request` 把全部引用作为 `ticket_refs` 传给 chat_turn，Coordinator 可以沿用它决定下一轮动作。

引用只提供上下文，不复制 Task，不重复旧对话，也不绕过路由与护栏。

## Ticket 详情

详情统一展示：

- Decision 的 why、state、space 和 `run.task_ref`；
- herdr-task 的执行状态；
- Receipt 的 summary、details、proof；
- Diff 与 Review 批注；
- Accept / Rework / Drop / Later。

这些动作只回到 Coordinator，不使用 shepherdr 原生 Accept 来闭合流程。

## 完整闭环

```text
New / Build / Event
  → Coordinator 或路由表
  → Decision
  → Ticket / Working
  → herdr-task
  → Receipt / Review
  → Coordinator 再判断
  → Delivery / Rework / Settled
```

人的 New / Build 是 chat_turn，不占机器 job turn 的预算。机器事件由 Ingress 去重、归并和路由，两个入口共用 Ledger、Decision 和双循环。
