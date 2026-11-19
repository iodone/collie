---
kind: "playbook"
id: "bug-fix"
title: "Bug fix"
version: 1
source: "dsx:bug-fix"
when:
  - "defect"
  - "regression"
  - "failing check"
requires:
  - "role:coordinator"
  - "role:worker"
  - "role:reviewer"
  - "role:verifier"
discloses:
  - "reference:review-axes"
  - "reference:three-gates"
stages:
  - id: "reproduce"
    role: "coordinator"
  - id: "fix"
    role: "worker"
    needs:
      - "reproduce"
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
    predicate: "repro_passes"
allowed_next:
  - "review"
---

# Bug fix

Playbook stages: reproduce → fix → review → verify → accept
