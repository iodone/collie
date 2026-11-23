---
kind: "playbook"
id: "ratchet"
title: "Ratchet"
version: 2
---

先立一条更严格的检查，并列出当前过不了的文件；检查只增不减。

每一轮只把一个文件或一项修到通过，单独提交，并重新跑全量检查。driver 负责收敛和记录清单变化；reviewer 检查遗漏；需要时启动 verifier 确认清单外没有回归。

清单为空才算完成。无法继续的一项标为 blocked，不硬凑通过。
