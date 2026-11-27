# protocol/

这里是 [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) 的可执行协议。设计以架构文档为准。

## 对象

| 对象 | 作用 |
|:--|:--|
| **Message** | 进入 Coordinator 的一条消息：`source` 为 event 或 human；正文只以 `data_ref` 指路径 |
| **Event** | 外部事实：`source + key` 去重，同对象归并，不可变；它是 `source=event` 的 Message |
| **Case** | 递给 coordinator 的一次 job：Message + 有界快照 + policy |
| **Decision** | Coordinator 的业务判断及 service/system 的护栏、失败和 finalization 写入：`open / waiting / settled`，带 actions 与 why |
| **Task** | 独立的执行状态机：`todo / running / ready / done`；canonical `ref`（如 `COLL-42`）贯穿 spawn、adopt、Receipt 与 Artifact |
| **Work** | `Decision + Task + live agent` 的只读投影，不是第三个持久状态机 |
| **Card** | `Decision{state:"waiting"}` 的人面投影：`open → decided / closed` |
| **Receipt** | herdr-task `ready` 的 summary/details/proof |
| **Policy** | 内置默认 policy + 用户可编辑的 per-space policy（自然语言） |

Card 不是新对象；Queue 不是对象，是所有 `waiting` Decision 的现算视图。Coordinator 拥有判断；service/system 可以写 Decision 的 guard、answer、failure 与 finalization revision，Driver 不写 Decision。

## 状态

```text
Decision: open（系统持有） | waiting（人持有） | settled（终态 + outcome）
Task:     todo | running | ready | done
Work:     Todo | Working（kind=build/review/verify） | Needs you | Settled
```

- 判断中、待执行、执行中、重试都是 `open` 的 phase，不是持久状态。
- Driver 只推进到 `ready`；Accept、Archive 或通用 Card drop 由 service 终结为 `done`，rework 通过 `start` 复用同一 Task。Inbox Archive 写 `settled{outcome:"archived"}` 并保留证据，不复用 `drop/dropped`。
- `failed` 不是 Task 状态：需要人 → Decision `waiting` + alert Card；重试 → `open`；终结 → `settled{outcome:"failed"}`。
- `ack ≠ settled`；只有 `settled` 能结案。
- 外部事件与人的对话是两个输入面；人的对话不进 Ingress，不产生 Event。
- `snapshot.active` 提供未终结 Decision 与 orphan Task 的目标、动作和引用。续接使用 `decision_ref`，同一 Decision 追加 revision 并复用 Task；`decision_ref + spawn_task` 非法。
- `run.kind` 固定为 `build / review / verify`，只描述 Task 当前动作；外部对象的 `kind:id` 保留原始类型，不参与目标判断。
- `budget.per_hour` 默认每 60 分钟滑动窗口 100 次，预算耗尽进入 `open` Todo；Todo 提供 `Run now / Archive / Quote`，不需要为预算通知开 driver 或出 Needs you 卡。
- Inbox 的精确投影优先级见 [`../docs/TASK-LIFECYCLE.md`](../docs/TASK-LIFECYCLE.md) §2.5。

## 不变量

1. **事件不可变**：Event 只追加；外部正文不拼进提示词。
2. **一个判断者**：每 space 一个 coordinator；没有第二个 dispatcher。
3. **一个队列**：只有 `waiting` Decision 是队列。
4. **两个持久状态机**：Decision 三态与 Task 四态分别持久化；Work 四态是投影。
5. **一个 Message 契约**：事件和人的消息共用 `urn:collie:message:v1`；人的消息不伪造 Event。
6. **policy 是人的**：coordinator 只能起草，不能自改。
7. **所有外部事件过 Coordinator**：外部事件统一交给 Coordinator 判断。
8. **hops 熔断**：超过上限只记录 + Card，不派发。
9. **ack ≠ settled**：看到不等于处理完。
