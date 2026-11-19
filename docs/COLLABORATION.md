# Collie Collaboration Protocol

**状态：** v1 设计，代码逐步落地（issue #39）

Collie 的协作模型把“谁负责什么”和“按什么顺序工作”分开。

```text
Space / Project / Task / CoordinatorTurn / Role / Playbook / Gate / Inbox
```

一句话：

> Role 管职责，Playbook 管顺序，Task 管执行，Coordinator 管判断，人管裁决。

---

## 1. 边界

| 概念 | 作用 | 不负责 |
|---|---|---|
| Space | 协作域：Coordinator、helper、policy、Inbox | git repo、worktree |
| Project | 执行域：repo、folder、task store | 人的决策 |
| Task | 一件被执行的工作 | 定义 workflow |
| Coordinator | 判断、选择 playbook、分发 Ticket/Task | 写代码、review、verify、裁决 |
| Role | 一类职责和禁项 | 绑定某个 agent |
| Playbook | stage 序列、role 引用、gate | 运行时状态 |
| Gate | 通过条件与结果 | 第二套 Inbox 状态 |
| Human | 最终裁决 | 交付物 |

---

## 2. CoordinatorTurn

Event 和 human message 是同一个 `CoordinatorTurn` / `Case` 的两个 origin，不是两套协议。

```text
CoordinatorTurn
├── origin: event | human
├── stream: job_turn | chat_turn
├── input_ref
├── snapshot
├── Decision
└── reply?          # chat only
```

| Origin | 上下文 | 输出 |
|---|---|---|
| `event` | event data、queue、policy | Decision JSON；不进入 chat |
| `human` | conversation、queue、policy | Decision + optional reply |

两者共享 Ledger、policy、task fact。event 不可见对话；human 可直接回答 Card 或创建 ticket。

纯问答也产生 `noop/settled` Decision，保持 turn 可审计。显式人工表单（UI New/Build）是 `decided_by=human` 的直接 Decision，不属于 Coordinator 模型判断。

`Decision` 只追加，包含：

- `origin`
- `playbook: {id, version}`
- `project`
- `why`
- `actions`
- 状态与 Card

---

## 2.1 Command boundary

Collie 保留两个 CLI 面，因为它们代表两个不同事实：

|命令面|事实|谁能用|
|---|---|---|
|`collie ticket`|Decision / Ticket|人、Coordinator|
|`collie decision`|Coordinator chat 提交 Decision|Coordinator chat|
|`collie task`|公开的原子任务命令面|用户自定义 prompt、agent|
|`collie-task`|内部 Task Adapter；实现 `collie task`|Collie runtime，不直接写给 agent|

`collie-task add` 不是 Coordinator 的进件入口；它会绕过 Decision/playbook 选择。ticket/Decision 与 task 不合并成一个命令，否则边界会重新混在一起。

## 3. Role registry

Role 定义职责、禁项、输入、输出；不绑定具体 agent。

```ts
type Role = {
  id: string;
  title: string;
  purpose: string;
  duties: string[];
  prohibitions: string[];
  inputs?: string[];
  outputs?: string[];
  modes?: Record<string, { input?: string; output?: string; tools?: string[] }>;
};
```

内置：

- `coordinator`
- `worker`
- `reviewer`：只判断该不该这样写，不跑三验
- `verifier`：只判断能不能用，不改代码
- `planner`
- `researcher`

Runner 单独配置：

```json
{
  "roles": {
    "verifier": {
      "agent": "pi",
      "model": "default",
      "effort": "high",
      "perm": "read-only"
    }
  }
}
```

---

## 4. Playbook registry

Playbook 定义 stage、role 引用和 gate。它不复制 role 文本。

```ts
type Playbook = {
  id: string;
  title: string;
  version: number;
  when?: string[];
  stages: Array<{
    id: string;
    role: string;
    needs?: string[];
    parallel_with?: string;
    outputs?: string[];
    gate?: string;
  }>;
  gates?: Array<{ id: string; predicate: string }>;
  allowed_next?: string[];
};
```

内置 playbook 直接对齐 DSX：

| DSX playbook | Collie playbook | 主要阶段 |
|---|---|---|
| `dsx-playbook-feature` | `feature` | explore → design → implement → review ∥ verify → accept |
| `dsx-playbook-bug-fix` | `bug-fix` | reproduce → fix → review ∥ verify → accept |
| `dsx-playbook-review` | `review` | review → accept |
| `dsx-playbook-investigation` | `investigation` | investigate → accept |
| `dsx-playbook-refactoring` | `refactoring` | test-net → refactor → review ∥ verify → accept |
| `dsx-playbook-prototype` | `prototype` | build → observe → decide |
| `dsx-playbook-ratchet` | `ratchet` | tighten → fix → review → verify → accept |
| `dsx-playbook-hillclimb` | `hillclimb` | measure → iterate → verify → decide |
| `dsx-playbook-eval` | `eval` | frame → candidates → judge → decide |
| `dsx-playbook-orchestrate` | `orchestrate` | frame → drain → verify → decide |

DSX 的 `name` 可以作为别名使用；Collie id 是 canonical。

角色映射：

| DSX 职责位 | Collie role | 备注 |
|---|---|---|
| 协调位 | `coordinator` | 判断、选择 playbook、分发 |
| 执行位 | `worker` | 实现与提交 |
| review 位 | `reviewer` | 三轴审查，不跑 verify |
| 验证位 | `verifier` | 三验、verdict、evidence |
| 方案位 | `planner` | 设计与 pass predicate |
| 守护位 | `watcher` | 基础设施/异常观察 |
| 决策位 | 人 | 不是 agent role |


示例：

```text
feature:
  implement(worker)
  review(reviewer) ∥ verify(verifier)
  accept(human)

review:
  review(reviewer)
  accept(human)
```

Playbook 是模板，不是硬路由表。Coordinator 可以在 allowlist 内选择、组合 extension；未注册的 playbook/role 直接失败。

---

## 5. Task

Task 只持久化运行事实，不持久化 playbook 定义。

```json
{
  "playbook": { "id": "feature", "version": 1 },
  "stage": { "id": "verify", "state": "active" },
  "seats": [
    { "role": "worker", "agent": "codex", "status": "done" },
    { "role": "reviewer", "agent": "claude", "status": "done" },
    { "role": "verifier", "agent": "pi", "status": "working" }
  ],
  "gate_results": [
    { "id": "review", "verdict": "pass", "ref": "artifact:..." },
    { "id": "verify", "verdict": "pending" }
  ]
}
```

不存：

- stage 列表
- seat 定义
- gate predicate
- role prompt

这些由 registry 提供，Inbox 读时投影。

---

## 6. Review 与 Verify

这是两个职责，不是一个 reviewer 的两种工作。

| Seat | 问题 | 禁止 |
|---|---|---|
| reviewer | 该不该这样写 | 跑三验、改代码、裁决 |
| verifier | 能不能用 | 改产品代码、听转述、裁决 |

两者钉同一个 commit，可以并行。合并规则：

```text
review pass + verify pass → human accept
review blocking finding   → 回 worker
verify fail / uncertain   → 阻塞，事实优先
```

`ready` 不再只要求 reviewed；它按 playbook 的 gate 要求。

---

## 7. Inbox

Inbox 状态机不变：

```text
Todo → Working → Needs you → Settled
```

映射：

| Inbox | Decision | Task |
|---|---|---|
| Todo | open，未执行 | 未启动 |
| Working | open | worker/reviewer/verifier 在跑 |
| Needs you | waiting | 需要人回答、授权、验收 |
| Settled | settled | 完成或明确不做 |

stage / seats / gates 只是 Working 的内部 metadata 和详情展示，不新增 `Reviewing`、`Verifying`、`Failed` 等顶层状态。

---

## 8. 配置与加载

内置定义不是 TypeScript 常量，而是模板目录：

```text
templates/roles/*.json       # 角色定义
templates/playbooks/*.json   # playbook 定义
```

安装后它们落在 `~/.config/herdr-core/templates/roles` 和 `~/.config/herdr-core/templates/playbooks`；Service 的 registry 从这里加载，用户/项目配置再覆盖。

加载层级（后者覆盖前者）：

```text
Collie built-in
  → ~/.config/collie/roles, playbooks
  → <project>/.collie/roles, playbooks
  → <project>/.agents/skills/collie/roles, playbooks
  → task/space explicit override
```

规则：

- 未知 role/playbook、非法 stage、未知 role 引用：fail closed。
- repo 可以提供 role/playbook 内容，但不能自动提高 runner 权限。
- event payload 不能选择 role/playbook。
- Coordinator 或人可以选择；Task 锁定 playbook id/version/digest。
- playbook 变更不静默改写运行中的 Task。

---

## 9. 迁移路径

1. 先把三份静态模板注册为 role；保持现有行为。
2. 新增 `verifier`，把 reviewer 的 checks 职责移出。
3. 给 Decision/Task 加 `playbook`；内置 feature/review/bug-fix/investigation。
4. 支持 review/verify 并行和 gate_results。
5. 最后开放用户/repo 自定义 role/playbook 与 UI 编辑。

Inbox 的状态机在每一步都不变。
