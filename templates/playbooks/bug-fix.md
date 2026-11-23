---
kind: "playbook"
id: "bug-fix"
title: "Bug fix"
version: 1
---

先复现缺陷并记录失败证据；再做最小修复并提交。

让 reviewer 检查回归风险；需要独立验证时启动 verifier，确认复现用例通过。最后提交 ready，带上 summary、details 和 proof。
