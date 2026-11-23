---
kind: "playbook"
id: "review"
title: "Review"
version: 2
---

这是一次只读评审，不实现、不提交。

driver 负责确认评审范围和 base/head，然后启动 reviewer。reviewer 按 Spec / Standards / 结构三轴审 diff，报告 findings 和 unproven；不要启动 verifier，也不要把「需要跑起来证明」的内容写成 review 结论。

完成后提交 ready，交付 review 报告和证据。是否合并由人决定。
