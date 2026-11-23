---
kind: "playbook"
id: "bug-fix"
title: "Bug fix"
version: 2
---

先自己复现缺陷，记录失败证据；再二分定位，每轮只排除一个假设，不猜。

driver 做最小修复并提交。修复后让 reviewer 检查影响范围和回归风险；需要独立验证时，启动 verifier，用同一复现路径确认失败已消失，并记录证据。

原始复现通过是这次修复的定义性证据。review 的 Important 或 verifier 的 fail / uncertain 都阻塞。通过后提交 ready。
