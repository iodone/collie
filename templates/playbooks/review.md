---
kind: "playbook"
id: "review"
title: "Review"
version: 4
---

# Review

## 目的

评审一个已经在别处完成的 diff。  
这个 playbook 只做 review，不做实现，也不做验证。

## 输入

- review target：MR / PR / commit range / worktree
- base 和 head
- 完整 diff
- brief / 原始需求
- 已有讨论和评审记录

## 流程

### 1. 固定范围

确定要审的 diff 和 base/head。  
如果本任务也负责实现，不要使用这个 playbook；在实现流程里单独调用 reviewer。

### 2. 先读已有讨论

读 diff 上的 note、评审记录和 brief。  
已经提出且回应过的问题不要重开；真没修好才重开，并说明这次复现为什么不同。

### 3. 建证据面

把 worktree 拉到 head，读完整树。  
有结构索引就建索引；没有就降级 grep，并在报告中标注「降级取证」。

### 4. 调用 reviewer

reviewer 按自己的三轴判据审查：

```text
Spec / Standards / 结构
```

playbook 不复制三轴细则；判据由 reviewer role 持有。

### 5. 收 findings

reviewer 按 `Important / Nit / Pre-existing` 报告。  
每条 finding 给出位置、证据、级别和修复方向；每条都要处理或写明不处理的理由。

### 6. 分开 review 和 unproven

- `review`：diff 该不该这样写的判断
- `unproven`：必须运行、起服务或写测试才能证明的内容

review 不跑验证：

- 不写测试、不改测试、不跑全量套件
- 只允许确认单条 finding 的仓库已有命令
- 单条 finding 最多 1 条命令
- 定向取证总时长 ≤20 分钟

### 7. 交付

reviewer 把报告交给发起 review 的执行者。  
执行者负责把报告评论到目标 PR / 评审位置；reviewer 不直接写 PR。

报告包含：

```text
文件路径
三行以内摘要
逐条自检
未解决问题
```

## 角色

- **reviewer**：读 diff、按三轴判断、交 findings 和 unproven
- **执行 review 的 agent**：确定范围、启动 reviewer、把报告贴到 PR
- **人**：决定是否接受、是否合并

## 结论

- reviewer 只给 findings，不宣布通过，不给合并建议。
- 人决定是否接受和合并。
- 需要运行才能证明的内容进入 `unproven`，交给独立验证。
