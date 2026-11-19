---
kind: "playbook"
id: "refactoring"
title: "Refactoring"
version: 1
source: "dsx:refactoring"
when:
  - "behavior-preserving change"
  - "rename"
  - "extract"
  - "move"
requires:
  - "role:worker"
  - "role:reviewer"
  - "role:verifier"
stages:
  - id: "test-net"
    role: "worker"
  - id: "refactor"
    role: "worker"
    needs:
      - "test-net"
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
    predicate: "behavior_unchanged_findings_clear"
  - id: "verify"
    predicate: "tests_and_surface_unchanged"
allowed_next:
  - "review"
---

# Refactoring

Playbook stages: test-net → refactor → review → verify → accept
