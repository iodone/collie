---
kind: "playbook"
id: "feature"
title: "Feature"
version: 2
---

先勘察受影响区域，再把设计说清楚；至少比较两个结构不同的方案，写下什么可观察状态算通过。

driver 在写定的范围内实现、运行定向检查并提交。提交后让 reviewer 按 Spec / Standards / 结构审 diff；需要独立判断能不能用时，启动 verifier 做三验。

review 和 verify 钉同一个 commit。review 有 Important 时回到 driver 修复；verifier fail 或 uncertain 时阻塞。两边都通过后提交 ready，交给人决定是否接受。
