---
kind: "playbook"
id: "review"
title: "Review"
version: 3
---

这是一次独立评审：只审别人或别处已经完成的改动，不实现、不验证。

## 1. 确定范围

- 审哪个 MR / PR / commit range / worktree。
- 固定 base 和 head；后续所有判断只对这个 head 有效。
- 如果本任务也负责实现，不要使用这个 playbook；应在 feature / bug-fix / refactoring 的 review 步骤里调用 reviewer。

## 2. 先读已有讨论

- 读 diff 上已有的人类 note、评审记录和 brief。
- 已经提出且回应过的问题不要重开；真没修好才重开，并说明这次复现为什么不同。

## 3. 建证据面

- 把 worktree 拉到 head，读完整树，不只读 diff。
- 有结构索引 / 调用图就先建索引。
- 没有索引就降级 grep，并在报告中标明「降级取证」。

## 4. 三轴审查

driver 启动 reviewer；reviewer 按自己的 role prompt 做三轴审查：

```text
Spec / Standards / 结构
```

playbook 不复制三轴判据；判据只在 reviewer role 中维护。

## 5. Findings

reviewer 按以下级别报告：

```text
Important / Nit / Pre-existing
```

每条给出文件、行或可复核位置、证据和修复方向。  
每条 finding 必须被处理：修掉，或写明理由后 resolve。

## 6. 分开写 review 和 unproven

- `review`：该不该这样写，三轴 findings。
- `unproven`：需要运行、起服务、写测试才能证明的内容；交给 verifier。

review 不跑验证：
- 不写测试、不改测试、不跑全量套件。
- 只允许为确认一条 finding 使用仓库已有命令；单条 ≤1 条命令。
- 定向取证总时长 ≤20 分钟；超时即停，交现有证据和 `unproven`。

## 7. 回执

```text
文件路径
三行以内摘要
逐条自检
未解决问题
```

## 8. 结尾

- 报告交付即结束。
- 需要返工时，findings 交回 driver / Coordinator。
- 不启动 verifier；验证是另一个 playbook / 另一个 role 的事。
- 不给合并建议；是否合并由人决定。

## 与 DSX 的差异

DSX standalone review 允许在「无 Important 且获得人类授权」时 approve。  
Collie 保持一个固定边界：reviewer 不 approve、不 merge，统一由人决定。  
除此之外，范围、已有讨论、证据面、三轴、findings、unproven、取证预算和回执流程均保留。
