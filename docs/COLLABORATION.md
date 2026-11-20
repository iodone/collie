# Collie Collaboration Protocol

**状态：** 当前设计  
**核心：** Coordinator 判断，Driver 执行，Helper 承担局部 role，Task 记录事实。

---

## 1. 边界

| 概念 | 作用 | 不负责 |
|---|---|---|
| Space | 协作域：Coordinator、policy、Inbox | git repo、worktree |
| Project | 执行域：repo、folder、task store | 人的决策 |
| Coordinator | 判断输入、选择 playbook、分发 task | 写代码、review、verify |
| Driver | task 的执行所有者，读 playbook 并自行编排 | 跨 task 判断、人的裁决 |
| Helper | 同一 task 下的局部 role terminal | 第二个 task、第二个 driver |
| Playbook | 交给 driver 的工作编排 prompt | stage 状态机 |
| Role | 职责、禁项、输入输出 | 绑定某个 agent |
| Task | 执行事实：状态、review、verify、receipt | 定义 workflow |
| Human | 最终裁决 | 交付物 |

接收 playbook 的 agent 是 **driver**；它本身也可以工作，也可以启动 helper role。

---

## 2. Coordinator

Coordinator 是 space 内唯一判断者。

输入：

- Event
- Human message
- task-level receipt
- policy / queue / recent / budget

输出：

```text
Decision
├── origin: event | human
├── playbook: { id, version }?
├── project?
├── why
├── actions[]
└── state: open | waiting | settled
```

常用 action：

- `spawn_task`
- `ask`
- `priority` / `hold`
- `emit_command`
- `propose_policy`
- `noop`

Coordinator 负责：

- 识别输入意图
- 继续已有 Ticket / Task
- 选择 playbook
- 处理人的 steering / Card / accept
- 读 task receipt 决定继续、rework、settle

Coordinator 不负责：

- task 内部 role 顺序
- 启动 reviewer / verifier
- 执行实现、review、verify
- 写 task facts

Event 和 human message 共用同一 Decision 契约；入口只改变输入。

---

## 3. Driver

每个 task 有一个 driver。

driver 收到：

- task brief
- playbook prompt
- role catalog
- task 命令

driver 可以做：

- 自己完成工作
- 启动 helper role
- 等待 helper 的 findings / verdict
- 修复并继续
- 记录 review / verify
- 提交 ready receipt

driver 不做：

- 修改 Ledger
- 修改 policy
- 替人 accept
- 把 task 变成另一个 Coordinator

driver 是 task-local 角色，不是全局 dispatcher。

---

## 4. Playbook

Playbook 是 prompt，不是 stage schema。

```text
Playbook
├── id
├── version
├── title
└── body
```

`body` 交给 driver，描述这个 task 如何展开：

- 先做什么
- 何时启动 reviewer
- 如何处理 findings
- 何时启动 verifier
- 什么条件下 ready
- 哪些动作需要人

不包含：

- stage 列表
- seat 状态
- gate 执行器
- 自动推进游标

Playbook 可以写：

```text
实现并提交；需要时启动 reviewer；
review 有 must-fix 就修；
需要三验时启动 verifier；
最后记录 ready。
```

流程可变。不是所有 playbook 都包含 implement / review / verify。

---

## 5. Role

Role 定义职责、禁项、输入输出；不包含 playbook 流程。

```ts
type Role = {
  id: string;
  title: string;
  purpose: string;
  duties: string[];
  prohibitions: string[];
  inputs?: string[];
  outputs?: string[];
};
```

内置角色示例：

- `coordinator`：外循环判断
- `driver`：task 所有者，负责局部编排
- `reviewer`：只读审查
- `verifier`：独立验证
- `planner` / `researcher` / `watcher`：按需局部角色

Role 和 Playbook 解耦：

```text
Playbook 决定何时用 role
Role prompt 决定这个 role 怎么做
```

driver 从 catalog 取 role prompt，再把 prompt 交给 helper terminal。

---

## 6. Task 与 helper

### 6.1 启动

Coordinator 的 Decision：

```json
{
  "state": "open",
  "playbook": { "id": "feature", "version": 1 },
  "actions": [{
    "kind": "spawn_task",
    "risk_tags": [],
    "spawn": { "title": "...", "brief_ref": "...", "base": "current" }
  }]
}
```

service 创建 task，启动 driver。driver 读 brief 和 playbook body。

### 6.2 helper 连接

driver 启动 helper：

```text
hc run --bg
  --name <task>-review
  --label herdr.task=<task>
  --label herdr.role=reviewer
  --label herdr.agent=<cli>
  -- <reviewer prompt>
```

约束：

- helper 是 driver 的 `hc` child
- helper 共享 `herdr.task`
- helper 用 `herdr.role` 标识局部角色
- helper 不创建新 task
- helper 不写 Work 状态

### 6.3 交接

driver 用：

```text
hc wait <helper>
hc read <helper>
hc kill <helper>
```

读取局部结果。

driver 用 `collie task reviewed` / `collie task verified` 记录事实；最后 `collie task ready` 提交 receipt。

helper 的 findings / verdict 不等于 Worker 状态，也不等于 Work 状态。

---

## 7. 状态同步

### 7.1 三层事实

```text
Work       Todo / Working / Needs you / Settled
Task       running / ready / reviewed / verified
Helper     working / blocked / idle
```

### 7.2 Work 投影

| Work | 来源 |
|---|---|
| Todo | task 未 running；Decision open |
| Working | driver 或 helper 活跃 |
| Needs you | 问题、阻塞、待验收、approval |
| Settled | Decision settled |

Work 只由 Decision + task facts 投影，不写回 Ledger。

### 7.3 phase

可以显示：

```text
Working · building
Working · reviewing
Working · verifying
```

phase 是读时投影：

- driver 工作 → building
- reviewer 活跃 → reviewing
- verifier 活跃 → verifying

phase 不持久化，不驱动下一步。

### 7.4 关键规则

- helper 完成不会自动推进 Work。
- `ready` 不等于 `done`。
- `ack` 不等于 settled。
- 只有 accept / drop / 终结让 Work 进入 Settled。
- helper 提问且 driver 无法代答时，Work 才是 Needs you。

---

## 8. 回执循环

```text
Coordinator chooses playbook
  → task
  → driver
  → helpers / local work
  → task facts / receipt
  → Coordinator
```

- helper 级结果回到 driver。
- driver 级结果回到 Coordinator。
- Coordinator 不需要每个 helper 的 turn。
- 需要继续同一 Work 时，新 Decision 引用已有 Ticket / Task。

---

## 9. 失败

- reviewer findings → driver 修复
- verifier fail → driver 修复
- helper 崩溃 / 超时 → driver 重试或升级
- driver 无法处理 → task blocked / Card
- Coordinator 读 task receipt，决定 continue / rework / ask / settle

不可逆动作必须 approval Card。

---

## 10. 命令边界

| 动作 | 命令 |
|---|---|
| 人明确建 Ticket | `collie ticket create` |
| Coordinator 提交 Decision | `collie decision commit` |
| 读 Ticket / Decision | `collie ticket show` |
| 读 task facts | `collie task show/status` |
| 执行 task 操作 | `collie task ...` |
| 查看 registry | `collie roles list` |

`collie-task` 是内部 task CLI，不是用户/prompt 契约。

---

## 11. 配置

加载层级：

```text
built-in
  → ~/.config/collie/roles, playbooks
  → <project>/.collie/roles, playbooks
  → <project>/.agents/skills/collie/roles, playbooks
  → task / space override
```

规则：

- 后者覆盖前者
- 未知 role / playbook fail closed
- repo 不能自动提高 driver/helper 权限
- Event payload 不能选择 role/playbook
- Task 锁定 playbook id/version

---

## 12. 不变量

1. 一个 space 一个 Coordinator。
2. 一个 task 一个 driver。
3. helper 不是第二个 driver，也不是第二个 task。
4. Playbook 不是运行时状态机。
5. Work 四态；phase 只是投影。
6. helper 完成不自动推进 Work。
7. `ready` 不是 `done`；`ack` 不是 settled。
8. Coordinator 只看 task-level receipt。
9. Task facts 是唯一执行事实源。
10. 人保留最终裁决权。

---

