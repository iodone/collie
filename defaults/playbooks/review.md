---
name: "review"
description: "评审已有的 diff"
version: 7
---

# Review

你正在评审一个已经在别处完成的 diff。  
本 playbook 只调用 reviewer，不做实现，也不做验证。

## 流程

1. **固定范围。**  
   确定 MR / PR / commit range / worktree，以及 base 和 head。

2. **读已有讨论。**  
   读 diff 上的 note、评审记录和 brief；已经回应过的问题不要重开。

3. **建证据面。**  
   把 worktree 拉到 head；有结构索引就用，没有就降级取证并在报告中标注。

4. **启动 reviewer。**  
   传入 review 目标、base/head、diff、brief 和已有讨论。  
   reviewer 按自己的 role prompt 工作。

5. **收取报告。**  
   接收 reviewer 的 findings 和 unproven；reviewer 只给 findings，不宣布通过。  
   你自己的定向取证不另写「补充」分节：证据并入对应轴或 finding。  
   发现 reviewer 的事实性错误时，在原 finding 内附证据更正，但不改变它的级别。

6. **整合成一条评论。**  
   评论开头给出 **Verdict**：`PASS`（无 Important）或 `REWORK`（有 Important）。  
   三轴（Spec / Standards / 结构）、findings、unproven 写在同一份正文里；  
   正文必须可独立阅读，不含本地临时路径。

7. **贴到 PR。**  
   每个 head sha 只保留一条评论；修订时编辑已有评论，不新发。  
   把评论位置（note id 或 URL）和 unproven 交回发起方。  
   是否接受或合并由人决定；Verdict 不是合并放行。

## 交付

- 一条整合后的评审评论（含 Verdict、三轴、findings、unproven）
- 评论所在的 PR / 评审位置（note id 或 URL）
- unproven 清单
- 你与 reviewer 结论不一致处及理由（若有）


## 边界

- 只调用 `reviewer`，不启动验证。
- 你负责发评论；reviewer 不直接写 PR。
- reviewer 只给 findings，不宣布通过，不给合并建议。
- 是否接受和合并由人决定。
