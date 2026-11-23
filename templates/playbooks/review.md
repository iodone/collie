---
kind: "playbook"
id: "review"
title: "Review"
version: 1
---

只读检查指定 task、commit 或 diff，不修改代码、不提交。

按 blocker / major / minor 报告 findings，每条给出文件、证据和修复建议。完成后提交 ready，交付 findings 和证据。
