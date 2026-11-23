---
kind: "playbook"
id: "hillclimb"
title: "Hillclimb"
version: 1
---

先测量基线，再做可回滚的优化并重新测量。

每轮保留真实指标，比较收益和风险；需要时启动 verifier 复核。达到目标或收益不足时提交 ready。
