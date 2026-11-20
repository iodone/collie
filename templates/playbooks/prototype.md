---
kind: "playbook"
id: "prototype"
title: "Prototype"
version: 1
source: "dsx:prototype"
when:
  - "design decision"
  - "cheap experiment"
  - "are we sure"
requires:
  - "role:worker"
  - "role:verifier"
stages:
  - id: "build"
    role: "worker"
  - id: "observe"
    role: "verifier"
    needs:
      - "build"
  - id: "decide"
    role: "human"
    needs:
      - "observe"
allowed_next:
  - "feature"
  - "refactoring"
---

# Prototype

## 读法

frontmatter 是机器契约；本文件正文是流程说明，不覆盖 frontmatter 的 stage/gate 定义。

## 执行

按 frontmatter 的 stages 顺序执行；标有 `parallel_with` 的 stage 可以并行，必须钉同一个 commit。
每个 stage 引用 registry 中的 role；需要人裁决的 stage 是 `human`。
gate 全部通过后，才进入 accept；任何 `fail` 或 `uncertain` 不得跳过。
