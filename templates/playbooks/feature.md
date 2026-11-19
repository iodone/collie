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

Playbook stages: explore → design → implement → review → verify → accept
