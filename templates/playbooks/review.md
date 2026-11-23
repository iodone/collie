---
kind: "playbook"
id: "review"
title: "Review"
version: 5
---

# Review

## 场景

评审一个已经在别处完成的 diff。  
本 playbook 只调用 reviewer，不做实现，也不做验证。

## 参与者

- **执行者**：确定范围、启动 reviewer、把报告贴到目标 PR / 评审位置。
- **reviewer**：按自己的 role prompt 执行 review，交付 findings 和 unproven。
- **人**：决定是否接受、是否合并。

## 流程

1. **固定范围。**  
   确定 MR / PR / commit range / worktree，以及 base 和 head。

2. **读已有讨论。**  
   读 diff 上的 note、评审记录和 brief；已经回应过的问题不要重开。

3. **建证据面。**  
   worktree 拉到 head；有结构索引就用，没有就降级取证并在报告中标注。

4. **启动 reviewer。**  
   传入 review 目标、base/head、diff、brief 和已有讨论。  
   reviewer 按自己的 role prompt 工作。

5. **收取报告。**  
   接收 reviewer 的 findings 和 unproven，不改写它的结论。

6. **贴到 PR。**  
   执行者把 reviewer 报告评论到目标 PR / 评审位置。

7. **交还结果。**  
   review 报告和 unproven 交回发起方。  
   是否接受或合并由人决定。

## 交付

- reviewer 报告
- 报告所在的 PR / 评审位置
- unproven 清单

## 边界

- 本 playbook 只调用 `reviewer`，不启动验证。
- 执行者不代替 reviewer 做判断。
- reviewer 不直接写 PR；评论由执行者完成。
- 人决定是否接受和合并。
