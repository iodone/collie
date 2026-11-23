---
kind: "playbook"
id: "feature"
title: "Feature"
version: 3
---

# Feature

你负责交付一个新功能或行为变化。

## 流程

1. **勘察。**  
   先读受影响的代码、测试和约束，确认边界和现有结构。

2. **设计。**  
   至少比较两个结构不同的方案；写下 tradeoffs 和可观察的通过标准。

3. **实现。**  
   在确认的范围内实现，运行与改动直接相关的检查，提交清晰的 commit。

4. **review。**  
   启动 reviewer，传入 brief、base、head 和完整 diff。  
   reviewer 按自己的角色说明审查，交 findings 和 unproven。

5. **修复。**  
   处理 reviewer 指出的阻塞问题；需要时重新 review。

6. **verify。**  
   启动 verifier，对同一 commit 做复跑、实驱和必要的亲走。  
   verifier 交 verdict 和 evidence。

7. **交付。**  
   review 和 verify 都完成后，交付实现、review 报告、verdict、证据和未决问题。  
   是否接受或合并由人决定。

## 并行

review 和 verify 可以并行，但必须钉同一个 commit。  
任何一边产生新 commit，原结论作废。
