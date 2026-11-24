# Collie CLI

> Agent 启动时读取的精简契约在 `~/.config/collie/skills/cli/SKILL.md`；本文是完整人工手册。

`collie` 是 Coordinator、Driver 和运维人员操作 Collie 的**唯一命令面**。
service 的本地 HTTP 路由（`/ticket`、`/decision`、`/v1/collaboration`）是实现细节，不给 Coordinator 或外部客户端直接使用。

## 1. 安装位置

安装器把 CLI 写到：

```text
~/.local/bin/collie
~/.config/herdr-app/bin/collie
```

`collie` 自身带两个通用参数：

```text
--root <dir>       隔离的 HOME，用于测试安装
--state-dir <dir>  Ledger / queue / socket 所在目录
```

默认 `--root` 是当前 HOME，默认 state 是 `~/.local/state/collie`。

## 2. 命令总览

| 命令 | 用途 |
|---|---|
| `collie roles list` | 读取当前 Role / Playbook registry |
| `collie roles reload` | 让 service 重新读取 Role / Playbook 文件 |
| `collie ticket create` | 从 title + brief 创建 Ticket 和 spawn Decision |
| `collie ticket adopt` | 给已有 task 补一条持久 Decision |
| `collie ticket show` | 按 Decision id 或 task ref 读 Ticket 投影 |
| `collie decision commit` | 提交一个已经判断好的 Decision JSON |
| `collie decision deliver` | 重试一个已授权 Decision 的 `emit_command` |
| `collie task add/list/show/start/status/ready/accept/done` | 读取或推进四态 Task；不提供其他子命令 |
| `collie intake event` | 以 native Event client 身份调用 `/v1/ingress` |
| `collie status` | 查看 service / Herdr / Coordinator 概览 |
| `collie service status` | 只查 service 健康 |
| `collie service install/start/stop/uninstall` | 管理 service 生命周期 |
| `collie doctor` | 校验安装完整性 |
| `collie update` | 按 manifest 更新已安装文件 |
| `collie coordinator restart` | 原地重启 Coordinator agent |

## 3. Coordinator 命令

### 3.1 `collie roles list`

```sh
collie roles list
```

输出当前 registry：

- `roles`
- `playbooks`
- `directives`（system / config / defaults 路径）

Coordinator 在选择 playbook 前应先执行它，不要凭聊天记忆猜 playbook 名称。

### 3.2 `collie ticket create`

```sh
collie ticket create \
  --space <space> \
  --title "修复登录回归" \
  --brief - \
  --kind build \
  --project <project> \
  --playbook bug-fix
```

参数：

- `--space`：协作 space
- `--title`：任务标题
- `--brief`：brief 文件路径、`-`（stdin），或直接内联文本
- `--kind`：`build` | `review`
- `--project`：可选，space 下的 project
- `--playbook`：可选，必须来自 `collie roles list`

行为：

```text
humanMessage()
  → coordinate()
  → 一个 spawn_task Decision
  → collie-task add/start
```

stdout 是 JSON：

```json
{
  "decision_id": "dc_...",
  "ticket_ref": "COLL-42"
}
```

一个命令只创建一个 Decision 和 task。标题或 brief 不合法时返回非零退出码，stderr 是错误原因。

### 3.3 `collie decision commit`

```sh
collie decision commit \
  --space <space> \
  --file /tmp/decision.json \
  --turn-id turn-123
```

`--file -` 从 stdin 读。文件是 `urn:collie:decision:v1`：

```json
{
  "state": "settled",
  "why": "这次问题只需要状态说明",
  "actions": [],
  "settled": {
    "at": "2026-11-24T00:00:00Z",
    "by": "coordinator",
    "outcome": "dropped"
  }
}
```

service 会：

- 写一条 human Message；
- 调 `coordinate()` 校验 schema；
- 固定 `id`、`key`、`space`、`event_ref`、`occurrence` 等身份字段；
- 执行 `spawn_task`，或把 `waiting` 投影成 Card。

`--turn-id` 用于幂等重试；同一个 turn id 只落一次。

### 3.4 `collie decision deliver`

```sh
collie decision deliver --decision dc_...
```

当 Decision 含 `emit_command`，并且人在 Card 上选择 accept 后，service 会自动 delivery。
如果 delivery 失败，使用此命令重试。

### 3.5 `collie ticket show`

```sh
collie ticket show --decision dc_...
collie ticket show --ticket COLL-42
```

输出 Decision 的 Ticket 投影：

```json
{
  "decision_id": "dc_...",
  "state": "open",
  "space": "...",
  "ticket_ref": "COLL-42",
  "project": "collie",
  "playbook": "feature",
  "kind": "build",
  "why": "新建 ticket：..."
}
```

### 3.6 `collie ticket adopt`

```sh
collie ticket adopt \
  --space <space> \
  --task <task-ref> \
  --folder <repo-folder> \
  --kind review
```

用于已经由 `collie task` 直接创建、但没有 Decision 的 orphan task。
它补一条不 spawn 的 Decision，让 Inbox 能继续投影，不会重复派工。

## 4. Task 命令

`collie task` 是公开的原子任务命令面，内部由 vendored `collie-task` 执行。公开子命令只有：

| 命令 | 状态变化 / 用途 |
|---|---|
| `collie task add <title> [--prompt <brief>]` | 创建 `todo` Task |
| `collie task list [--json]` | 列出 Task |
| `collie task show <task> [--json]` | 读取一个 Task 的执行事实 |
| `collie task start <task>` | `todo → running`；rework 时也用于 `ready → running`，并重启 terminal 已移除的 stopped-running Task；始终复用同一 Task |
| `collie task status <task> "<progress>" [--done 40] [--left 5m]` | 更新 `running` Task 的进度，不改变状态 |
| `collie task ready <task> --summary "..." --details "..." --proof "..."` | `running → ready`，提交通用 receipt |
| `collie task accept <task>` | 仅 `ready → done`；接受交付，不执行 merge、PR 或其他 delivery |
| `collie task done <task>` | drop / finalization → `done`；由 service 调用 |

所有 `<task>` 都使用 canonical Task ref（例如 `COLL-42`）；spawn / adopt / Receipt / Artifact 全链路不使用 key 或 id 兼容回退。

`summary`、`details`、`proof` 都是 `ready` 的必填交付字段；`proof` 必须是可核验引用。review / verify 是 playbook 编排的 helper 活动，不是 Task 命令、字段或 `ready` gate。

```sh
collie task list --json
collie task show COLL-42 --json
collie task status COLL-42 "正在修复测试" --done 40 --left 5m
collie task ready COLL-42 \
  --summary "登录回归已修复" \
  --details "更新会话校验并补充回归检查" \
  --proof "art-login-proof-a1b2"
```

Coordinator 或人选择 accept / drop 后由 service 终结 Task；选择 rework 时，service 对同一 Task 调用 `start`。`start` 也用于 terminal 已移除的 stopped-running Task 原地恢复，不新建 Task。`drop` 是 Card 选项，不是 `collie task` 子命令。merge / comment / close 由 playbook / Decision delivery 控制，与 Task accept 无关。

Artifact 只有在 `artifact.task` 指向该 Task，或被 `Task.proof` 显式引用时，才进入 Ticket 的 Artifacts；不会根据日志或发布时间推断归属。

## 5. Event Ingress

### 5.1 `collie intake event`

```sh
collie intake event --file payload.json --space <space>
```

或 stdin：

```sh
collie intake event --file - --space <space> < payload.json
```

CLI 会把 payload POST 到 service 的 `/v1/ingress`。
如果 payload 已经是完整 Collie Event，原样使用；否则由 `intakeEvent` 生成 Event shell，正文写入：

```text
~/.local/state/collie/intake/ev_*.json
```

可选 bearer token：

```sh
collie intake event \
  --file payload.json \
  --space <space> \
  --token-env COLLIE_INGRESS_TOKEN
```

## 6. 运维命令

```sh
collie status
collie service status
collie service install
collie service stop
collie service start
collie doctor
collie update --yes
collie coordinator restart <terminal>
```

- `status`：service、Herdr core、app、Coordinator 概览。
- `service status`：只读 `/health`，返回 `ok`、pid、uptime、state dir。
- `doctor`：只检查安装完整性，不代表运行正常。
- `update`：按 manifest 更新；本地修改会保留为 `.new` 并让 doctor 报红。

## 7. 输出与错误约定

- 大多数命令 stdout 是 JSON 或 JSONL；`collie task` 的输出由 `collie-task` 决定。
- 成功返回 0；参数、service、校验失败返回非零。
- 错误正文在 stderr；Coordinator 应把错误原文交回，不要根据聊天记忆伪造成功。
- 对外 ingress 只有 `/v1/ingress` 和 `/v1/in/<source>`；`collie intake event` 是 native client 的 CLI 包装。

## 8. 相关文档

- [ARCHITECTURE.md](ARCHITECTURE.md) — CLI 在系统中的位置与事件/chat 序列图
- [RUNBOOK.md](RUNBOOK.md) — 安装、排障、service 生命周期
- [SETTINGS.md](SETTINGS.md) — Role / Playbook / runner 配置
