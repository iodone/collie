# Collie · Settings 设计

> 目标：把“角色定义”和“角色运行配置”分开，把“系统固定”“默认提供”“用户自定义”“项目自定义”分开。
>
> **定义编辑只在文件系统完成。** Settings 只负责展示来源、路径和可编辑的 runner；不提供 role / playbook 定义编辑器。

---

## 1. 数据模型

### 1.1 Role

```ts
type Role = {
  id: string;
  title: string;
  purpose: string;
  duties: string[];
  prohibitions: string[];
  inputs?: string[];
  outputs?: string[];
  origin: "builtin" | "user" | "project";
  file: string;
};
```

`origin` 表示实际加载来源，`file` 表示实际读取的 Markdown 文件。

### 1.2 Playbook

```ts
type Playbook = {
  id: string;
  version: number;
  title: string;
  body: string;
  origin: "builtin" | "user" | "project";
  file: string;
};
```

Playbook 没有 `stage` / `seat` / `gate` 运行时结构。`body` 是交给 driver 的编排 prompt。

### 1.3 Runner

Runner 是角色的运行配置，不属于角色定义：

```json
{
  "driver": {
    "agent": "codex",
    "model": "default",
    "effort": "high",
    "perm": "auto"
  }
}
```

- Role 定义不可被 runner 改写。
- Runner 不改 role 的职责、禁项或 prompt。
- 系统角色只允许修改 runner。

---

## 2. 来源和优先级

### 2.1 角色

```text
system fixed
  coordinator
  driver

built-in defaults
  reviewer
  verifier
  planner
  researcher
  watcher

user custom
  ~/.config/collie/roles/*.md

project custom
  <project>/.collie/roles/*.md
```

优先级：

```text
built-in defaults
  < user custom
  < project custom
```

固定角色例外：

```text
coordinator / driver 不能出现在 user 或 project 的 roles 目录中。
出现即拒绝加载，提示 system role cannot be overridden。
```

### 2.2 Playbook

```text
built-in playbooks
  templates/playbooks/*.md

user playbooks
  ~/.config/collie/playbooks/*.md

project playbooks
  <project>/.collie/playbooks/*.md
```

优先级相同：

```text
built-in < user < project
```

每个 playbook 加载后记录：

```text
origin
file
version
```

Task 实际使用哪个 playbook、版本和来源，要从 task facts / Decision 里可查。

### 2.3 不再加载

```text
<project>/.agents/skills/collie/roles
<project>/.agents/skills/collie/playbooks
```

这与 `.collie` 重叠，保留会让来源和优先级不清晰。

---

## 3. Settings 导航

左侧导航分组：

```text
System roles
  Coordinator
  Driver

Default roles
  Reviewer
  Verifier
  Planner
  Researcher
  Watcher

Custom roles
  <user/project roles>

Playbooks

Connections
  Ingress
  Sources

Workspace
  Spaces

System
  Diagnostics
```

规则：

- `System roles` 始终置顶。
- `Custom roles` 为空时隐藏整组，不显示空标题。
- 同名 role 只显示最终生效项；详情里显示来源和覆盖路径。
- Playbook 使用 `playbook:<id>` 作为 section key，避免和 role id 冲突。

---

## 4. Role 详情

### 4.1 通用头部

```text
Title
System fixed · builtin
file path

Purpose
Duties
Prohibitions
```

来源 badge：

| origin | badge | 定义来源 |
|---|---|---|
| builtin system | System fixed | 安装物，不可覆盖 |
| builtin default | Built-in | 可被 user / project 同名文件覆盖 |
| user | User | 文件系统维护 |
| project | Project | 文件系统维护 |

### 4.2 系统角色

`coordinator` / `driver`：

```text
Definition
  System fixed. Only runner settings are editable.
  file: .../roles/coordinator.md

Runner
  Agent
  Model
  Effort
  Permission
```

- 不显示 prompt 编辑器。
- 不显示 delete / rename。
- 只保存 runner 配置。
- Runner 配置仍按 Everywhere / space 覆盖。

### 4.3 默认角色

例如 `reviewer`：

```text
Source: builtin
file: .../roles/reviewer.md

Definition: built-in
Runner: editable
```

- 可以编辑 runner。
- 可以通过 user/project 同名 role 覆盖定义。
- 覆盖后显示 `origin: user/project` 和覆盖文件路径。

### 4.4 自定义角色

```text
Title
Source: user / project
file: ...

Duties / Prohibitions
Runner: read-only
```

- 定义只从 Markdown 文件读取。
- Settings 不提供 definition 编辑器、创建或删除。
- 第一版 custom role 的 runner 也是只读；运行配置先只开放给系统/默认角色。
- 修改、删除都由文件系统完成；Settings 只反映下一次加载后的状态。

### 4.5 Runner 表单

适用于系统角色和默认角色；custom role 第一版只读。

| 字段 | 控件 | 规则 |
|---|---|---|
| Agent | segmented | claude / codex |
| Model | text input | 空 = CLI default |
| Effort | segmented | low / medium / high / xhigh / max |
| Permission | segmented | auto / ask / acceptEdits |

保存规则：

- segmented 立即保存。
- text 在 blur 保存。
- 保存成功显示 `Saved`，2 秒后消失。
- 校验失败显示 inline error，不写文件。
- 系统角色保存到 `~/.config/collie/settings.json` 的对应 role key。
- Coordinator 保存到 `~/.config/collie/coordinator.json`。

---

## 5. Playbook 详情

### 5.1 列表

```text
Feature
feature@1 · builtin · templates/playbooks/feature.md

Review
review@1 · builtin · templates/playbooks/review.md
```

分组：

```text
Built-in
User
Project
```

### 5.2 详情

```text
Title
id@version
origin
file

Body
  <prompt preview>
```

- 不显示 stage / seat / gate。
- 不提供 stage 编辑器。
- 不提供创建、删除或复制动作。
- 编辑 playbook 就是编辑文件系统中的 Markdown body。
- 内置 playbook 可以被 user/project 同名文件覆盖；详情显示最终来源。
- 覆盖时提示：

```text
This playbook is overridden by <project>/.collie/playbooks/feature.md.
```

### 5.3 文件管理

Settings 不创建或覆盖 playbook。文件位置就是唯一入口：

```text
~/.config/collie/playbooks/<id>.md
<project>/.collie/playbooks/<id>.md
```

覆盖内置 playbook 时使用同名 id；下次加载后显示新的 `origin` 和 `file`。

不在 Settings 内做 Markdown frontmatter / body 编辑器。

---

## 6. 交互细节

### 6.1 加载

```text
GET /v1/collaboration
```

返回：

```json
{
  "roles": [{ "id": "driver", "origin": "builtin", "file": "...", ... }],
  "playbooks": [{ "id": "feature", "version": 1, "origin": "builtin", "file": "...", "instructions": "..." }]
}
```

- Settings 不自己扫描目录。
- 来源和覆盖由 service registry 给出。
- 项目级 role/playbook 只有在当前项目加载后才出现。

### 6.2 空状态

- 没有自定义角色：隐藏 `Custom roles` 分组。
- 没有 playbook：显示“无 playbook”。
- 加载失败：显示错误和重试按钮，不缓存半份数据。

### 6.3 固定角色冲突

如果用户/项目目录出现 `coordinator.md` 或 `driver.md`：

```text
coordinator is a system role and cannot be overridden
```

Settings 显示：

```text
Invalid override
  ~/.config/collie/roles/coordinator.md
  coordinator is a system role and cannot be overridden
```

服务启动时也应 fail closed，而不是静默忽略。

### 6.4 项目切换

- 当前项目决定 project 层 role/playbook。
- 切换项目时重新请求 `/v1/collaboration`。
- 不把上一个项目的自定义 role 留在导航里。

---

## 7. 不变式

1. 系统角色定义只读，runner 可改。
2. Settings 不编辑任何 role / playbook 定义。
3. 默认角色定义可被 user/project 覆盖。
4. 内置 playbook 可被 user/project 覆盖。
5. 自定义目录只有两个层级：user、project。
6. 不加载 `.agents/skills/collie`。
7. Role 定义与 runner 分开。
8. Playbook 是 prompt，不提供 stage 编辑器。
9. 每个加载项有 `origin` 和 `file`。
10. Task 记录实际 playbook id / version / origin。
11. 固定角色冲突 fail closed。
