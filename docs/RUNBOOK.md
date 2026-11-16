# collie 安装与排障

## 路径模型

安装器把 `--root` 当作隔离的 HOME。默认 root 是当前用户的 HOME；指定 root 后，所有写入都限制在该目录内：

| 内容 | root 下的位置 |
| :-- | :-- |
| layout、mods、lib、CLI | `.config/herdr-app/` |
| `collie-sync` helper | `.local/bin/collie-sync`（herdr-app 的 `bin/` 也保留一份） |
| 提示词 | `.config/herdr-core/templates/` |
| 后台 runtime（service / kernel / plugins / protocol） | `.local/share/collie/` |
| 运行状态与初始 `ruleset.json` | `.local/state/collie/` |
| manifest | `.config/herdr-app/installed.collie.json` |
| 替换备份 | `.config/herdr-app/.collie-backup/<UTC 时间>/` |

安装器不联网，不拉取依赖，也不修改 shepherdr 源码。runtime 保持仓库相对目录，因此 `service/main.ts` 对 kernel、plugins 和 protocol 的相对导入在安装后不变。初始路由表从 `protocol/fixtures/ruleset.json` 复制到状态目录；后续本地修改与代码文件一样受 `.new` 保护。`lib/addons/collie.json` 是本 add-on 的元数据，避免覆盖 shepherdr 的 add-on 清单。独立 manifest 文件名也避免覆盖 herdr-app 已有的 `installed.json`。

## 前置依赖

- Python 3.10+；
- herdr / shepherdr，且 `herdr-task` 在 `PATH`；
- shepherdr 3.1.x 提供的 `herdr-task` 执行层；
- `bun`、`git` 在 `PATH`；
- Inbox 使用独立 layout，不依赖 shepherdr 的 Assistant、Tasks、Files、Changes、Artifacts 页面。

版本优先从 `.config/shepherdr/installed.json` 或 herdr-app 的 `data/shepherdr/installed.json` 读取；没有这些文件时依次尝试 add-on 元数据和 `herdr-task --version`。缺依赖时安装会在写入前停止。

## 安装

保留源码 checkout。更新和 doctor 都会使用 manifest 记录的原始路径。

```sh
./install.sh --yes
bin/collie doctor
```

隔离安装适合验收，不会读取或写入真实 HOME：

```sh
ROOT=$(mktemp -d)
# 在 $ROOT 内准备 shepherdr 依赖，并将依赖命令放入 PATH。
./install.sh --root "$ROOT" --yes
bin/collie doctor --root "$ROOT"
```

先看计划而不写文件：

```sh
./install.sh --root "$ROOT" --dry-run
```

安装和更新结束时自动运行 doctor。只有所有文件 hash、可执行权限、layout mods、依赖、状态目录和源码 checkout 都正常，命令才返回 0。

## 启动后台

默认安装后直接运行：

```sh
bun "$HOME/.local/share/collie/service/main.ts"
```

隔离 root 必须同时隔离进程的 HOME，否则服务会回到真实 HOME 找状态：

```sh
HOME="$ROOT" \
HERDR_INBOX_STATE="$ROOT/.local/state/collie" \
HERDR_INBOX_RULESET="$ROOT/.local/state/collie/ruleset.json" \
bun "$ROOT/.local/share/collie/service/main.ts"
```

看到 `collie service ready` 后，服务按秒消费状态目录的 `incoming/*.json`，并把已消费文件改名为 `.done`。窗口不是后台的运行前提；停止窗口不会停止这个进程。

## Coordinator 与 New / Build

每个 space 有一个逻辑 coordinator，由共享 Coordinator Host 按需调用，不常驻空转进程。配置位于 `$HOME/.local/state/collie/coordinator.json`：

```json
{
  "everywhere": {
    "coordinator": { "cli": "codex", "model": "default", "effort": "high" }
  },
  "spaces": {
    "collie": {
      "coordinator": { "cli": "claude", "model": "default", "effort": "medium" }
    }
  }
}
```

space 配置覆盖 Everywhere；未配置有效 `cli` 时不会静默选择另一款 agent。CLI 只返回 Decision JSON，spawn、护栏和 delivery 仍由 service 执行。

Inbox 顶部的 New / Build 输入通过 `/request` 进入 chat_turn，不占机器 job turn 预算。`Decision.run.coordinator_ref` 保存会话引用，供 Card Review 恢复。没有配置 coordinator 时，New / Build 会明确报错，不会降级到 shepherdr Assistant。

## Coordinator 常驻与恢复

每个 space 的 Coordinator 由 `collie-supervisor` 保证：激活 space 时去重接管，后台每 10 秒检查。恢复语义直接复用 shepherdr 的 `revive.py`：

- live Coordinator 直接接管，不重复启动。
- 运行中持续记录原 argv、cwd、session 和 log。
- kept terminal 退回 shell 时，在同一 terminal 恢复原 session。
- terminal 已消失时新建 terminal，但仍 resume 同一 session。
- session log 不存在时新建 session，并带 handover，不伪造恢复成功。
- 普通关闭 Coordinator Tab 使用 settle；只有 `collie-supervisor stop --space <id>` 才禁止自动拉起。

恢复模块只接管带 `herdr.inbox=true` 的 Coordinator，不处理 shepherdr Assistant 或其他任务。

## 键位合并

`addons.json` 的 `keys` 会并入 herdr-app 的 `keys.json`：

- 空闲键直接添加；已有且值相同的键不改动。
- `--keys keep`：冲突时保留现有值。
- `--keys ours`：备份后使用 add-on 的值。
- `--keys ask`：逐个冲突询问。与 `--yes` 同用时不能隐式选择，遇到冲突会停止；请明确改用 `keep` 或 `ours`。

卸载只删除仍与本 add-on 写入值相同的键，人改过的键会保留。

## 更新与本地修改

```sh
bin/collie update --yes
bin/collie doctor
```

更新始终读取安装来源的 checkout，不跟随远端分支，也不从当前命令位置偷换来源。更新行为如下：

| 目标状态 | 行为 |
| :-- | :-- |
| 与旧 manifest hash 相同 | 先备份，再替换为新版 |
| 已被本地修改 | 保留原文件，新版写到 `<文件名>.new` |
| 不由 manifest 管理且内容不同 | 拒绝安装；明确使用 `--adopt` 后备份并接管 |
| 已从新版源码移除且未本地修改 | 备份后删除 |
| 已被本地修改 | 保留，doctor 报红 |

有 `.new` 时 doctor 不通过。逐文件比较并人工合并后，再由人决定替换或删除 `.new`；安装器不会猜测合并结果。

每次更新只写内容有变化的受管文件。manifest 记录每个目标相对隔离 HOME 的路径、SHA-256 和权限模式。

## 卸载

```sh
bin/collie uninstall --dry-run
bin/collie uninstall --yes
```

卸载删除 hash 仍匹配 manifest 的文件，保留本地修改过的文件。备份与 `.local/state/collie` 始终保留；卸载不会自动恢复旧备份，也不会删除事件或决定台账。

## 回滚

1. 对当前目标再跑一次 `doctor --root "$ROOT"`，保存失败项。
2. 在 `.collie-backup/` 中按时间找到更新前的目录。
3. herdr-app 文件的备份路径相对 herdr-app；模板等外部文件位于备份目录的 `external/` 下。
4. 停止相关进程后，由人把所需备份复制回原路径，再跑 doctor。

不要整目录覆盖备份：其中可能包含多个版本，也可能不含后来新增的文件。

## 同步共享 lib

仓库根目录的 `lib/*.js` 是唯一源。修改后同步到每个 mod：

```sh
bin/collie-sync --check
bin/collie-sync
bin/collie-sync --check
```

`--check` 发现差异返回 1，不写文件；`--dry-run` 只打印计划。源码 checkout 与 herdr-app 中的命令自动识别各自 root；`.local/bin` 的 helper 默认使用 `$HOME/.config/herdr-app`。隔离 root 下显式传 `--root "$ROOT/.config/herdr-app"`。

## 常见故障

| 症状 | 检查 |
| :-- | :-- |
| 安装前报缺依赖 | `PATH`、shepherdr 版本、`tasks` / `chat` mod 是否存在 |
| 报 unmanaged file differs | 确认文件归属；需要接管时显式加 `--adopt` |
| doctor 报 modified | 文件已偏离 manifest；保留修改或人工恢复，不直接重跑覆盖 |
| doctor 报 pending update | 处理对应 `.new`，不要删除原文件 |
| update 报 source unavailable | 恢复 manifest 中的源码 checkout；不要另换来源静默更新 |
| layout mod 缺失 | 安装对应 shepherdr mod，或先修复本包 layout 与 mod 的交付完整性 |
