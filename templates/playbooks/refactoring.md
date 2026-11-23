---
kind: "playbook"
id: "refactoring"
title: "Refactoring"
version: 2
---

先确认现有行为可验证；没有测试护网时先补行为测试。

driver 做小步、行为保持的重构；每一步单独提交，失败就回滚这一步。完成后让 reviewer 检查结构轴和回归风险；需要独立验证时启动 verifier，复跑测试并抽样检查 diff，确认行为没有改变。

重构和功能改动分开提交。review 的 Important 或 verifier 的 fail / uncertain 都阻塞。
