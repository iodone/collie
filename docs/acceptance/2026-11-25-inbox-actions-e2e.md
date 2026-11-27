# Inbox 列表操作 E2E 检查

生成 4 个独立 Ticket 和真实 proof artifact：

```sh
cd /Users/mi/work/system-weaver/projects/collie
node test/e2e-inbox-actions.mjs
```

在 Inbox 列表中逐行点击右侧的 `⋯` 菜单。不要从 Ticket 详情页执行这些检查。每次重建都会清除历史 E2E Decision 投影，只保留本次 4 条，避免同 ref 的历史行读到已删除或已完成的 Task。所有 E2E Task、Decision、Card 和 Proof 均以 `collie-e2e-` 开头；底层 canonical ref 仍使用 `COLL-914` 等格式。

`Receipts N` 中的 `N` 是当前 Task 的 Receipt 数量，不是版本号。`COLL-914` 有 3 份，`COLL-915` 和 `COLL-917` 各有 2 份；列表按最新 ready 倒序，Accept 始终展示最新一份。

| Ticket | 操作 | 预期结果 |
|---|---|---|
| `collie-e2e-accept` (`COLL-914`) | `Accept` | 弹出最后一次 Receipt 的 Summary、Details、Proof refs；`Cancel` 不改变状态；再次执行并 `Accept` 后进入 Settled |
| `collie-e2e-archive` (`COLL-915`) | `Archive` | Task 进入 done，Decision 显示 `Settled · archived`；Receipt 和 Proof 仍保留，可继续打开；不经过 `drop/dropped` |
| `collie-e2e-quote` (`COLL-916`) | `Quote` | 运行中只有 Quote；Coordinator 获得 Receipt/Task 上下文并获得焦点；Task 状态不变 |
| `collie-e2e-settled` (`COLL-917`) | 全局 `Receipts` → 最新 Receipt | 直接展示 Settled Ticket 的 Receipt 详情、Summary、Details 和 Proof refs，不停留在空列表 |

## 重点检查

1. 操作入口在**列表行尾 `⋯`**，菜单是 viewport overlay，不被滚动区域遮挡，不在 Ticket header 或 Receipt 详情中。
2. Accept 弹窗展示的是当前 Decision 的最新 Receipt，不是终端日志。
3. Accept 的 Cancel 不改变 Task / Decision。
4. 全局 `Receipts` 面板展示 Receipt 记录，不展示 Artifact 列表；Receipt 详情中的 Proof 只打开证据 viewer。
5. Archive 不删除 Receipt、Proof 或 artifact。
6. Settled 菜单只有 Quote，不提供 Resume 或 Delete；增量工作通过 Coordinator 新建 Task。
7. 菜单外部点击会关闭菜单，Ticket 行主体点击仍进入详情。
8. Task 记录已不存在但 Receipt 仍在时（如 `MIER-8`），从 Inbox 进入也必须按 `Decision.run.task_ref` 显示 Receipt，不能显示空态。
9. Coordinator chat 已关闭但其终端仍存活时，Quote 仍须发送到该 Coordinator，并切换到对应 space、tab 和 pane；不能只调用 `pane.focus`。
10. Task 记录已删除但 Decision 和 Receipt 仍在时，Accept 和 Archive 仍须结算 Decision；只有 Task 仍存在时，命令失败才阻止结算。
11. Quote 以最新 `Receipt.summary` 为主标题，附 details 和 Proof refs；`Decision.why` 只作为一条背景，不得代替 Receipt 结果或重复出现。
12. Card answer 不返回 `resumed`，也不根据 accept/rework/archive/drop/later 续接 Coordinator；增量工作只通过 Quote → Coordinator → 新 Task。
13. Review 评论是任务交付物：评论定稿后直接发布到 MR 并记录 note id，然后才能 ready；不得为发评论再出 accept 卡，Ticket accept 与评论发布分开。
14. 预算耗尽的 Decision 必须是 `open` Todo 且 `card=null`，保留已有 Task 关联；Todo 操作包含 `Run now / Archive / Quote`，Run now 复用当前 Task，Archive 完成当前 Task 并把真实 Decision 结算为 archived。
15. All 固定为 Needs you / Todo / Working / Settled，Settled 默认折叠；列表保留原第二行元信息，列表标题无点击复制，Task 详情标题点击复制。ready orphan Task 同样显示 Accept / Archive。
16. Todo 显示 scheduler 的依赖、并发或机器资源等待原因；Detail 在最左侧且只展示元信息，Receipts 独立展示交付列表和回执详情；Role / Agent 只在详情内出现，不自动创建主页面 Herdr tab。

清理 fixture（只清理本次生成的 E2E 记录和 proof）：

```sh
./bin/collie service stop
node test/e2e-inbox-actions.mjs --clean
./bin/collie service install
```

`--clean` 会同时清理 queue、Task、Receipt、Proof 和 Ledger 中的 E2E 源记录，并在 `~/.local/state/collie/backups/` 保留清理前的 Ledger 备份。清理前必须停止 service，否则旧 Ledger 会把 E2E 行重新投影回 Inbox。
