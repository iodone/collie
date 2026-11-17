# protocol/

这里是 [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) 的可执行协议。设计以架构文档为准。

## 对象

| 对象 | 作用 |
|:--|:--|
| **Event** | 外部事实：`source + key` 去重，同对象归并，不可变；正文只以 `data_ref` 指路径 |
| **Case** | 递给 coordinator 的一次 job：事件 + 有界快照 + policy |
| **Decision** | coordinator 的判断：`open / waiting / settled`，带 actions 与 why |
| **Card** | `Decision{state:"waiting"}` 的人面投影：`open → decided / closed` |
| **Receipt** | herdr-task `ready` 的 summary/details/proof + 风险 |
| **Policy** | 内置默认 policy + 用户可编辑的 per-space policy（自然语言） |

Card 不是新对象；Queue 不是对象，是所有 `waiting` Decision 的现算视图。

## 状态

```text
Decision: open（系统持有） | waiting（人持有） | settled（终态 + outcome）
Work:     Todo | Working（kind=build/review/merge） | Needs you | Settled
```

- 判断中、待执行、执行中、重试都是 `open` 的 phase，不是持久状态。
- `failed` 不是状态：需要人 → `waiting` + alert Card；重试 → `open`；终结 → `settled{outcome:"failed"}`。
- `ack ≠ settled`；只有 `settled` 能结案。
- 外部事件与人的对话是两个输入面；人的对话不进 Ingress，不产生 Event。

## 不变量

1. **事件不可变**：Event 只追加；外部正文不拼进提示词。
2. **一个判断者**：每 space 一个 coordinator；没有第二个 dispatcher。
3. **一个队列**：只有 `waiting` Decision 是队列。
4. **一个持久状态机**：Decision 三态；Work 四态是投影。
5. **policy 是人的**：coordinator 只能起草，不能自改。
6. **所有外部事件过 LLM**：没有确定性 route table / cache-first。
7. **hops 熔断**：超过上限只记录 + Card，不派发。
8. **ack ≠ settled**：看到不等于处理完。
