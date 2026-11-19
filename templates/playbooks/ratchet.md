---
kind: "playbook"
id: "ratchet"
title: "Ratchet"
version: 1
source: "dsx:ratchet"
when:
  - "tighten checks"
  - "reduce exception list"
  - "one-way migration"
requires:
  - "role:coordinator"
  - "role:worker"
  - "role:reviewer"
  - "role:verifier"
stages:
  - id: "tighten"
    role: "coordinator"
  - id: "fix"
    role: "worker"
    needs:
      - "tighten"
    outputs:
      - "commit"
  - id: "review"
    role: "reviewer"
    needs:
      - "commit"
    gate: "review"
  - id: "verify"
    role: "verifier"
    needs:
      - "commit"
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
    predicate: "exception_list_decreased"
allowed_next:
  - "review"
---

# Ratchet

## 读法

frontmatter 是机器契约；本文件正文是流程说明，不覆盖 frontmatter 的 stage/gate 定义。

## 执行

按 frontmatter 的 stages 顺序执行；标有 `parallel_with` 的 stage 可以并行，必须钉同一个 commit。
每个 stage 引用 registry 中的 role；需要人裁决的 stage 是 `human`。
gate 全部通过后，才进入 accept；任何 `fail` 或 `uncertain` 不得跳过。
