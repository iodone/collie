# Collie · Settings

> 配置分两层：**System** 是 Collie 自带的系统定义；**User** 是 `~/.config/collie/` 下的用户级配置。Settings 直接展示和编辑 User 层。

---

## 1. 顶层结构

```text
协作模式 | 连接 | 工作区 | 系统
```

「协作模式」的左侧栏：

```text
System
  Coordinator
  Driver
────
User
  Roles
  Playbooks
```

- `System` 下的 Coordinator / Driver 是固定系统角色，定义不可覆盖；页面只调整它们的 runner 配置。
- `User` 下的 Roles / Playbooks 全部来自 `~/.config/collie/`，可编辑、可新建。
- 没有 Builtin / User / Project 三层目录，也没有项目级配置。

---

## 2. 配置路径

```text
System roles
  ~/.config/herdr-core/templates/coordinator.md
  ~/.config/herdr-core/templates/driver.md

User config
  ~/.config/collie/roles/*.md
  ~/.config/collie/playbooks/*.md
  ~/.config/collie/skills/cli/SKILL.md
  ~/.config/collie/coordinator.json
  ~/.config/collie/settings.json
  ~/.config/collie/sources.json
  ~/.config/collie/workspaces.json
```

以下旧路径已废弃：

```text
~/.config/herdr-core/templates/roles/
~/.config/herdr-core/templates/playbooks/
<project>/.collie/roles/
<project>/.collie/playbooks/
<project>/.agents/skills/collie/
```

固定角色：

```text
coordinator / driver
```

用户不能创建或覆盖这两个 name。

---

## 3. Roles 页面

```text
Roles
  directory: ~/.config/collie/roles

  [ Select file ▾ ]  [ New ]
```

选中文件后的顶部操作栏：

```text
name.md                              Delete   Cancel   Save
Runner | Prompt
```

- 文件名使用普通文本样式，不加输入框外观；点击即可编辑，保存时改名会移动文件。
- 按钮遵循 Herdr 视觉规则：`New` / `Delete` 为 secondary，`Cancel` 为 plain，`Save` 为唯一的 primary。
- `Delete` 打开独立确认框；确认框的主按钮写动作本身（`Delete role` / `Delete playbook`），`Cancel` 为 plain。删除后重新加载 catalog。
- `Runner` 和 `Prompt` 是 tab：
  - Runner：工具、模型、思考强度，与 Coordinator / Driver 一致，写入 `~/.config/collie/settings.json`。
  - Prompt：带边框的整文件编辑器，YAML frontmatter 和 Markdown 正文一起编辑。

`New` 会立即在 `~/.config/collie/roles/` 创建一个完整模板文件并打开；不需要先填表单。

---

## 4. Playbooks 页面

```text
Playbooks
  directory: ~/.config/collie/playbooks

  [ Select file ▾ ]  [ New ]
```

页面使用同样的顶部操作栏和 `Prompt` tab：

- 文件名普通文本、Delete / Cancel / Save
- 整文件编辑器：YAML frontmatter + Markdown body

`New` 同样立即创建一个模板文件并打开编辑。

---

## 5. Frontmatter

Role 和 Playbook 使用同一套 skill 风格字段：

```yaml
---
name: reviewer
description: 判断一个已完成的 diff 该不该这样写
version: 5
---
```

- `name` 是稳定标识，必须唯一，建议与文件名一致。
- `description` 只用于选择，不承载完整 prompt。
- playbook 必须有 `version`，Decision 锁定 `name + version`；role 的 `version` 可选。
- review / verify 与 merge / comment / close 等 delivery 都写在 playbook 正文中，由 driver 按流程执行；frontmatter 不定义 Task gate。
- 正文承载职责、禁项和完整 prompt。

## 6. 保存与校验

- 整个文件原样写回，不再由 Settings 重新拼 frontmatter。
- 新建时自动选择不冲突的文件名，不覆盖已有文件。
- 文件名必须留在当前目录，不能包含路径分隔符或 `..`。
- 保存后调用 `collie roles reload`，让 coordinator / driver 立刻使用新定义。
- 文件写成功但 reload 失败时，错误留在页面上；文件本身不删除，可直接继续编辑。
- `Delete` 使用独立确认框，确认后删除文件并 reload。

---

## 7. 代码形状

```text
mods/collie-settings/main.js
  System / User 侧栏
  Roles / Playbooks 列表与整文件编辑器
  Runner / Prompt tabs
  Delete 确认框

lib/definition-files.js
  配置文件路径、ID 安全校验、新文件模板

service/answer-server.ts
  POST /v1/collaboration/reload

bin/collie
  roles reload
```

Settings 不保存第二份 role/playbook 状态：列表来自运行中的 catalog，文件内容来自磁盘原文，保存后只调用一次 reload。

---

## 8. 只读与可编辑边界

| 层 | 内容 | Settings |
|---|---|---|
| System | Coordinator / Driver 角色定义 | 只读；runner 可配 |
| User | Roles / Playbooks | 可读、可编辑、可新建 |
| User | coordinator / settings / sources / workspaces | 在对应页面配置 |

Runner 配置（CLI、model、effort）在 Coordinator / Driver 和每个 User Role 的 Runner 区配置，统一写入 `~/.config/collie/settings.json`，不写进 role 文件。

运行时消费：Driver 的 `agent/model/effort` 进入 `collie task add --agent/--model/--effort`；所有 helper role（包括 Reviewer / Verifier）的 runner 都写进 task brief 的 Role catalog，由 driver 按 playbook 启动 helper 时使用，不进入 Task 命令或 Task 字段。配置按 spawn 读取，不需要重启 service。

已配置的 Runner 或显式 restart `--argv` 优先。系统模板中的 `command: claude` 只是缺省与恢复 fallback，不覆盖已配置 runner；`collie coordinator restart` 会读取 Coordinator 模板的 `command` 来重建命令，因此该字段是运行时契约，不能当作无用 frontmatter 删除。
