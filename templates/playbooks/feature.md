---
kind: "playbook"
id: "feature"
title: "Feature"
version: 1
source: "dsx:feature"
when:
  - "new behavior"
  - "changed behavior"
  - "human build request"
requires:
  - "role:coordinator"
  - "role:worker"
  - "role:reviewer"
  - "role:verifier"
discloses:
  - "reference:review-axes"
  - "reference:three-gates"
stages:
  - id: "explore"
    role: "coordinator"
  - id: "design"
    role: "planner"
  - id: "implement"
    role: "worker"
    needs:
      - "design"
    outputs:
      - "commit"
  - id: "review"
    role: "reviewer"
    needs:
      - "commit"
    parallel_with: "verify"
    gate: "review"
  - id: "verify"
    role: "verifier"
    needs:
      - "commit"
    parallel_with: "review"
    gate: "verify"
  - id: "accept"
    role: "human"
    needs:
      - "review"
      - "verify"
gates:
  - id: "review"
    predicate: "no_blocking_findings"
  - id: "verify"
    predicate: "verdict_pass"
allowed_next:
  - "review"
  - "refactoring"
---

# Feature

## 读法

frontmatter 是机器契约；本文件正文是流程说明，不覆盖 frontmatter 的 stage/gate 定义。

## 执行

按 frontmatter 的 stages 顺序执行；标有 `parallel_with` 的 stage 可以并行，必须钉同一个 commit。
每个 stage 引用 registry 中的 role；需要人裁决的 stage 是 `human`。
gate 全部通过后，才进入 accept；任何 `fail` 或 `uncertain` 不得跳过。
