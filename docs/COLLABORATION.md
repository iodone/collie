# Collie Collaboration Protocol

**状态：** 当前设计  
**核心：** Coordinator 判断，Driver 执行，Helper 承担局部 role，Task 记录事实。

## 0. Autoloop

Collie 沿用 Agent Autoloop 的循环模型：

```text
事件 / 人的消息 / task receipt
              ↓
          Coordinator
              ↓
           Decision
              ↓
            Task
              ↓
          Receipt
              ↓
        Card / 状态 / 下一轮
```

- 默认安静，只有需要人时才出 Card。
- 执行者交局部事实，Coordinator 做全局判断。
- 一轮可以结束，Work 可以继续。
- 人保留不可逆动作和验收的裁决权。

---

## 1. 边界

| 概念 | 作用 | 不负责 |
|---|---|---|
| Space | 协作域：Coordinator、policy、Inbox | git repo、worktree |
| Project | 执行域：repo、folder、task store | 人的决策 |
| Coordinator | 判断输入、选择 playbook、分发 task | 写代码、review、verify |
| Driver | task 的执行所有者，读 playbook 并自行编排 | 跨 task 判断、人的裁决 |
| Helper | 同一 task 下的局部 role terminal | 第二个 task、第二个 driver |
| Playbook | 交给 driver 的工作编排 prompt | driver 的本地执行说明 |
| Role | 职责、禁项、输入输出 | 绑定某个 agent |
| Task | 执行事实：四态、进度、summary / details / proof | 定义 workflow、保存 review / verify / delivery gate |
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
├── playbook: { name, version }?
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

Event 和 human message 共用同一 Decision 契约；入口只改变输入。Coordinator 拥有业务判断，service/system 可以写 guard、Card answer、driver failure 和 accept / drop finalization revision；这些系统写入不构成第二个 dispatcher，Driver 不写 Decision。

### 2.1 Coordinator context

```text
静态 prompt
  ~/.config/herdr-core/templates/coordinator.md
  → 职责、边界、Decision 契约、默认 playbook 映射

动态注入
  catalog.playbooks: { name, description, version }
  event / human input
  queue / running / recent / policy / budget / space_note
```

程序从 CollaborationRegistry 读取 catalog 并注入 Case；Coordinator 只能从 catalog 选择 playbook。playbook / role 的正文不进入 Coordinator context，选中的 playbook 由 service 渲染进 task brief。

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
- 按 playbook 启动 helper role
- 等待 helper 的 findings / verdict
- 修复并继续
- 用 `status` 记录执行进度
- 按 playbook 执行或请求 delivery
- 提交只含 summary / details / proof 的 ready receipt

driver 不做：

- 修改 Ledger
- 修改 policy
- 替人 accept
- 把 task 变成另一个 Coordinator

driver 是 task-local 角色，负责当前 task 的执行。

---

## 4. Playbook

Playbook 是交给 driver 的编排 prompt。

```text
Playbook
├── name
├── description
├── version
└── body
```

`body` 交给 driver，描述这个 task 如何展开：

- 先做什么
- 何时启动 reviewer
- 如何处理 findings
- 何时启动 verifier
- 什么条件下 ready
- 哪些动作需要人

Playbook 可以写：

```text
实现并提交；需要时启动 reviewer；
review 有 must-fix 就修；
需要三验时启动 verifier；
最后记录 ready。
```

Playbook 按 task 需要选择 implement / review / verify 等步骤，也决定 merge / comment / close 等 delivery 何时执行、何时需要 Decision 授权。Decision 的 spawn 只选择 playbook 和执行目标，不含 `spawn.review` 或 `spawn.merge`；Task 不保存这些流程的 gate，accept 也不以 delivery 完成为前提。

---

## 5. Role

Role 定义职责、禁项、输入输出；playbook 负责编排这些 role 的使用方式。

来源规则：

```text
system fixed   coordinator / driver      定义只读，runner 可配
user config    ~/.config/collie/roles    用户自定义，可编辑、可新增
```

每个 role 记录 `origin: system | config` 和实际文件路径。

`coordinator` / `driver` 的 role 定义不可覆盖；只允许修改 runner。

详细 Settings 交互与配置规则见 [`SETTINGS.md`](SETTINGS.md)。

```ts
type Role = {
  name: string;
  description: string;
  version?: number;
  duties?: string[];
  prohibitions?: string[];
  inputs?: string[];
  outputs?: string[];
};
```

内置角色示例：

- `coordinator`：外循环判断
- `driver`：task 所有者，负责局部编排
- `reviewer`：只读审查
- `verifier`：独立验证
- 默认只提供 `reviewer` / `verifier`；其他角色由用户按需添加

Role 和 Playbook 解耦：

```text
Playbook 决定何时用 role
Role prompt 决定这个 role 怎么做
```

driver 从 role catalog 取 role name / description / file，再把 role prompt 交给 helper terminal。

---

## 6. Task 与 helper

### 6.1 启动

Coordinator 的 Decision：

```json
{
  "state": "open",
  "playbook": { "name": "feature", "version": 1 },
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
- helper 使用独立 Herdr tab；Ticket body 的 Terminal 始终属于 driver，helper-only 不抢占它

### 6.3 交接

driver 用：

```text
hc wait <helper>
hc read <helper>
hc kill <helper>
```

读取局部结果。

driver 自己按 playbook 决定 review / verify 是否完成；最后用 `collie task ready` 提交 task-level receipt。

helper 的 findings / verdict 不等于 Task 状态，也不等于 Work 状态。

---

## 7. 状态同步

### 7.1 三层事实

```text
Decision   open / waiting / settled
Task       todo / running / ready / done
Work       Todo / Working / Needs you / Settled
Helper     live terminal 状态（不进入 task state）
```

### 7.2 Work 投影

Work 只由 Decision + Task + live agent 投影，不写回 Ledger 或 task store。唯一规范判定表见 [`TASK-LIFECYCLE.md`](TASK-LIFECYCLE.md) §2.5：Decision settled / waiting 优先，其次是 live blocked / live roles，然后才是 Task ready / done / running。Task running 没有 live agent 仍为 Working；没有更高优先级条件时 Task done 为 Settled。

Ticket body 只有 Terminal 与 Artifacts。Terminal 属于 driver（已结束时可显示其历史 terminal）；reviewer / verifier / helper 各有独立 Herdr tab，helper-only 不能抢占 driver Terminal。Artifact 必须通过 `artifact.task` 或 `Task.proof` 显式绑定，不能从日志、publisher 或时间窗口推断。

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

phase 是读时投影；Task 的持久状态保持四态，Work 自身没有持久状态。

### 7.4 关键规则

- `Task.state` 只有 `todo / running / ready / done`。
- `ready` 只表示 driver 已交付；下一步 accept/rework/drop 由 Decision / Card 决定。
- helper 完成不会自动推进 Work。
- `ready` 不等于 `done`；`ack` 不等于 settled。
- Decision `settled` 让 Work 进入 Settled；没有更高优先级条件时 Task `done` 也进入 Settled，包括 orphan 或 Decision 仍为 open 的情况。accept / drop 同时终结对应 Task。

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

完整状态流转与最终交付见 [`TASK-LIFECYCLE.md`](TASK-LIFECYCLE.md)。

---

## 9. 失败

- reviewer findings → driver 修复
- verifier fail → driver 修复
- helper 崩溃 / 超时 → driver 重试或升级
- driver 无法处理 → service 写 Decision waiting / Card，Task 不增加 blocked 状态
- Coordinator 读 task receipt，决定 accept / rework / drop

不可逆动作必须 approval Card。

---

## 10. 命令边界

完整命令、参数和状态迁移以 [`CLI.md`](CLI.md) 为准；注入 Coordinator / Driver 的 `skills/cli/SKILL.md` 保持自包含，不依赖本文表格。

人通过 `collie ticket create` 明确建 Ticket，Coordinator 用 `collie decision commit` 提交判断，Driver 只用 `collie task status/ready` 记录进度和交付。accept / drop 后由 service 终结 Task，rework 对同一 Task 调 `start`。公开 `collie task` 子命令只有 `add / list / show / start / status / ready / accept / done`；`drop` 是 Card 选项，不是 task 子命令。

`collie-task` 是内部 task CLI，tick / revive / scheduler 等内部能力不进入公开命令面。Chat 只使用 `collie` CLI；`/ticket`、`/decision` 是 CLI 包装的本地 service 路由，不是对外 ingress。

---

## 11. 配置

Role / Playbook 的来源、优先级、系统固定规则和 Settings 细节见 [`SETTINGS.md`](SETTINGS.md)。

加载层级：

```text
system fixed roles
  coordinator / driver

user config
  ~/.config/collie/roles
  ~/.config/collie/playbooks
  ~/.config/collie/coordinator.json
  ~/.config/collie/settings.json
  ~/.config/collie/sources.json
  ~/.config/collie/workspaces.json
```

规则：

- `coordinator` / `driver` 的定义不可覆盖；只允许配置 runner（agent / model / effort / permission）。
- 所有用户级 role / playbook 都在 `~/.config/collie/`，可编辑和新增。
- Task 记录实际使用的 role / playbook 文件。
- 旧路径 `~/.config/herdr-core/templates/roles/`、`~/.config/herdr-core/templates/playbooks/`、`<project>/.collie/`、`<project>/.agents/skills/collie/` 不再加载。
- 未知 role / playbook fail closed。
- repo 不能自动提高 driver / helper 权限。
- Event payload 不能选择 role / playbook。
- Task 锁定 playbook name / version。

---

## 12. 不变量

1. 一个 space 一个 Coordinator。
2. 一个 task 一个 driver。
3. helper 不是第二个 driver，也不是第二个 task。
4. Playbook 是 driver 的编排 prompt。
5. Work 四态；phase 只是投影。
6. helper 完成不自动推进 Work。
7. `ready` 不是 `done`；`ack` 不是 settled。
8. Coordinator 只看 task-level receipt。
9. Task facts 是唯一执行事实源。
10. 人保留最终裁决权。

---

