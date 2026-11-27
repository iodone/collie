# 2026-11-24 · Collie 生命周期收口完成记录

> 本文件是 dated completion record，不是活跃 TODO，也不是当前契约的副本。
> 当前契约以 [ARCHITECTURE.md](ARCHITECTURE.md)、[TASK-LIFECYCLE.md](TASK-LIFECYCLE.md)、[CLI.md](CLI.md) 和 [../protocol/README.md](../protocol/README.md) 为准。

本次收口完成了以下设计与实现范围：

- Decision 与 Task 分成两个持久状态机；Task 只保留 `todo / running / ready / done`，Work 保持只读投影。
- Driver 只提交带 summary / details / proof 的 `ready`；accept / drop 终结 Task，rework 复用同一个 canonical Task ref。
- 公开 `collie task` 命令面收口为 `add / list / show / start / status / ready / accept / done`；内部 tick、恢复与调度继续保留。
- review / verify 由 playbook 正文编排 helper；merge / comment / close 保持 playbook / Decision delivery，不进入 Task 状态或 gate。
- Ticket body 只保留 Terminal 与 Receipts；helper 使用独立 Herdr tab，Receipt 按 Task ref 关联，Proof 通过现有 viewer 展示。
- Inbox 覆盖 Decision、Task、live agent 与 orphan / adopt 投影，移除旧 Task 状态、review / merge gate 和 artifact 推断路径。

后续工作不得把本记录当作仍需勾选的清单；新增问题进入当前架构、生命周期或运维文档所描述的正确 owner。
