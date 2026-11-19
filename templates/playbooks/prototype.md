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

Playbook stages: build → observe → decide
