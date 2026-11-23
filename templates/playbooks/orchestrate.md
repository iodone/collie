---
kind: "playbook"
id: "orchestrate"
title: "Orchestrate"
version: 1
---

先框定范围和依赖；连续处理可执行工作，遇到阻塞交回 Coordinator。

需要时启动 helper role 完成局部工作；持续记录事实。范围完成或无法推进时提交 ready。
