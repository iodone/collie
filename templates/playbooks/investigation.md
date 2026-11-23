---
kind: "playbook"
id: "investigation"
title: "Investigation"
version: 2
---

这是一次只读调查，不修改产品代码。

driver 自己建立结构和调用关系，追关键路径、历史决策和失败模式，产出有引用的报告，并明确区分事实、推断和未知项。不要启动 reviewer 或 verifier。

需要改动代码时，交回 Coordinator，重新选择 feature / bug-fix / refactoring。
