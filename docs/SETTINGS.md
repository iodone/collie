# Collie · Settings

> 定义编辑只在文件系统完成。Settings 负责展示目录、选择文件、预览 frontmatter 和正文；不提供 role / playbook 编辑器。

---

## 1. 顶层结构

```text
协作模式 | 连接 | 工作区 | 系统
```

### 协作模式

```text
Roles
  System roles
    Coordinator
    Driver
  Builtin
    Builtin roles
  User
    User roles
  Project
    Project roles

Playbooks
  Builtin
    Builtin playbooks
  User
    User playbooks
  Project
    Project playbooks
```

- `System roles` 单独铺开，因为它们是固定角色。
- Builtin / User / Project 各只有一个页面。
- 不在侧栏铺平每个 role 和 playbook 文件名。
- 文件名在页面内用下拉框选择。
- 每个页面只读。

---

## 2. 配置路径

```text
System roles
  ~/.config/herdr-core/templates/roles/

Builtin defaults
  installed roles / playbooks

User
  ~/.config/collie/roles/
  ~/.config/collie/playbooks/

Project
  <project>/.collie/roles/
  <project>/.collie/playbooks/
```

不再加载：

```text
<project>/.agents/skills/collie
```

优先级：

```text
builtin < user < project
```

固定角色：

```text
coordinator / driver
```

定义不可覆盖；用户或项目写入这两个 id 会被拒绝。

---

## 3. Role 页面

### 3.1 System roles

Coordinator / Driver 是独立页面：

- definition 固定，read-only
- 可以显示 runner 配置
- 不在 Builtin / User / Project 中重复出现

### 3.2 Builtin / User / Project roles

每个页面结构相同：

```text
Roles
  directory: /path/to/roles

  [ Select file ▾ ]

  Frontmatter
    id
    version
    title
    purpose
    duties
    prohibitions

  Content
    # Role
    ...
```

交互：

- 打开页面时只显示目录，不自动加载文件。
- 下拉框列出来自该目录、且 origin 匹配的 role 文件。
- 选中文件名后才读取文件。
- 前端展示 frontmatter 和正文。
- 全部只读。

---

## 4. Playbook 页面

### Builtin / User / Project playbooks

每个页面结构相同：

```text
Playbooks
  directory: /path/to/playbooks

  [ Select file ▾ ]

  Frontmatter
    id
    version
    title

  Content
    <playbook prompt>
```

交互：

- 打开页面不自动加载。
- 下拉框列出该 origin 的 playbook 文件名。
- 选中后读取文件并显示 frontmatter / body。
- 不显示 stage / seat / gate。
- 全部只读。

---

## 5. 下拉框行为

- 当前选择显示文件名。
- 点击展开文件列表。
- 选中后：
  - 关闭列表
  - 读取文件
  - 显示 frontmatter 和 content
- 文件为空：显示 `No files loaded`。
- 文件读取失败：显示错误，不伪造内容。
- 不跨 origin 混列文件。

---

## 6. 只读约束

Settings 不提供：

- role 定义编辑
- playbook 定义编辑
- 创建 / 删除 / 复制 / 覆盖按钮
- frontmatter 表单
- Markdown 编辑器

修改定义的方式：

```text
编辑 ~/.config/collie/roles/*.md
编辑 ~/.config/collie/playbooks/*.md
编辑 <project>/.collie/roles/*.md
编辑 <project>/.collie/playbooks/*.md
```

下一次打开或重新加载后，Settings 展示新内容。

---

## 7. 加载与来源

每个 role / playbook 记录：

```text
origin: builtin | user | project
file
```

- 分组表达来源。
- 页面内不重复显示 origin。
- 加载优先级只在文档说明。
- 项目切换后重新加载 catalog。
- 上一个项目的自定义内容不保留。

---

## 8. 不变式

1. System roles 单独展示。
2. Builtin / User / Project 各一个页面。
3. 页面内用下拉框选择文件，不铺平列表。
4. 选择后才读取和展示文件。
5. frontmatter 和 content 只读。
6. Settings 不编辑 role / playbook 定义。
7. 固定角色定义不可覆盖。
8. 不加载 `.agents/skills/collie`。
9. 每个加载项记录 origin 和 file。
10. Task 锁定实际 playbook id / version。
