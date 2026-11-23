---
kind: "playbook"
id: "eval"
title: "Eval"
version: 2
---

这个 playbook 属于 Coordinator 级别，不是单个 driver task。

Coordinator 定义评估问题和判定标准，为每个候选创建独立 task；候选之间使用同一 prompt 和隔离环境。评审由一个没有参与候选的 verifier 按同一标准完成。

driver 只负责自己的候选，不冒充 judge，也不看其他候选的标签。Coordinator 汇总证据、比较 tradeoffs，并把人留下最终决定。
