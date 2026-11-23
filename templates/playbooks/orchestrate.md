---
kind: "playbook"
id: "orchestrate"
title: "Orchestrate"
version: 2
---

这个 playbook 属于 Coordinator 级别，不塞进一个 driver task。

Coordinator 先框定范围、依赖和完成条件，再创建多个 driver task；每个 driver 只负责自己的单元，完成后交回 receipt。需要独立判断时，为关键交付启动 verifier。

持续处理可执行工作，遇到阻塞或范围变化交回 Coordinator。范围完成、预算到线或无法推进时，汇总 receipt / verdict，交给人决定下一步。
