# collie 安装与排障

## 路径模型

安装器把 `--root` 当作隔离的 HOME。默认 root 是当前用户的 HOME；指定 root 后，所有写入都限制在该目录内：

| 内容 | root 下的位置 |
| :-- | :-- |
| layout、mods、lib、CLI | `.config/herdr-app/` |
| helper（`collie-sync` / `collie-task` / `collie-secret`，外加 `collie-artifact`） | `.local/bin/`（herdr-app 的 `bin/` 也保留一份） |
| 提示词 | `.config/herdr-core/templates/` |
| 后台 runtime（service / kernel / plugins / protocol） | `.local/share/collie/` |
| 运行状态与初始 `ruleset.json` | `.local/state/collie/` |
| manifest | `.config/herdr-app/installed.collie.json` |
| 替换备份 | `.config/herdr-app/.collie-backup/<UTC 时间>/` |

安装器不联网，不拉取依赖，也不修改 shepherdr 源码。runtime 保持仓库相对目录，因此 `service/main.ts` 对 kernel、plugins 和 protocol 的相对导入在安装后不变。初始护栏/预算配置从 `protocol/fixtures/ruleset.json` 复制到状态目录；后续本地修改与代码文件一样受 `.new` 保护。`lib/addons/collie.json` 是本 add-on 的元数据，避免覆盖 shepherdr 的 add-on 清单。独立 manifest 文件名也避免覆盖 herdr-app 已有的 `installed.json`。

## 前置依赖

- Python 3.10+；
- herdr-app / herdr-core（hc）在 `PATH`；
- `bun`、`git` 在 `PATH`；
- 至少一个已登录的 CLI agent（Claude Code / Codex）；
- collie 自带 vendored `collie-task` / `collie-artifact`，不要求安装 shepherdr 的 `tasks` / `chat` / `artifacts` add-on；
- Inbox 使用独立 layout；Ticket 详情的 Terminal 用 herdr 的 terminal block，Artifacts 用 collie 自有的 `collie-artifacts`（列表与 viewer 工具栏同一个 mod）。

安装器在写入前检查 bundled `collie-task`、`bun`、`git`；不再读取 shepherdr 的 `installed.json`。

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

开发时可直接运行：

```sh
bun "$HOME/.local/share/collie/service/main.ts"
```

正式安装由 systemd user unit / launchd agent 管理：`RunAtLoad` + `KeepAlive`，开机自动拉起。**每台机器只有一个 collie service**，不是每个 space 一个。

```sh
collie service install      # 写 unit 并启动（真实 HOME）
collie service status       # GET /health: pid/uptime/state
collie service stop
collie service uninstall
```

隔离 root 的 `service install` 只写 unit，不调用 launchctl/systemctl。

隔离 root 必须同时隔离进程的 HOME，否则服务会回到真实 HOME 找状态：

```sh
HOME="$ROOT" \
HERDR_INBOX_STATE="$ROOT/.local/state/collie" \
HERDR_INBOX_RULESET="$ROOT/.local/state/collie/ruleset.json" \
bun "$ROOT/.local/share/collie/service/main.ts"
```

看到 `collie service ready` 后，服务按秒消费状态目录的 `incoming/*.json`，并把已消费文件改名为 `.done`。窗口不是后台的运行前提；停止窗口不会停止这个进程。

## Coordinator 与 New / Build

每个 space 有一个 Coordinator chat 和一个常驻 Coordinator helper。外面的 ingress 只进 helper；service 启动时和每 30 秒按 live Coordinator 确保 helper 存在，之后一直复用同一个 kept terminal。配置位于 `$HOME/.local/state/collie/coordinator.json`：

```json
{
  "everywhere": {
    "coordinator": { "cli": "codex", "model": "default", "effort": "high", "helper": "hidden" }
  },
  "spaces": {
    "collie": {
      "coordinator": { "cli": "claude", "model": "default", "effort": "medium" }
    }
  },
  "chat": { "agent": "claude", "model": null, "effort": null, "fast": false, "perm": "plan" }
}
```

`chat` 是 Coordinator chat 的 picker 记住的选择：下一次空 chat 从这里起步，首条消息按它启动。`model: null` 表示
用 CLI 自己的默认模型（不加 `--model`）。它只属于聊天，和 Coordinator helper 的 `everywhere.coordinator` 相互独立。

space 配置覆盖 Everywhere；未配置有效 `cli` 时不会静默选择另一款 agent。CLI 只返回 Decision JSON，spawn、护栏和 delivery 仍由 service 执行。

人的 New / Build、steering、回答 Card 都直接在 coordinator chat 里说；Inbox 只显示 `回复` 按钮，点击后把该 Work 的上下文发给 coordinator chat 并聚焦，由 LLM 先解释和建议。`collie-request` 仍保留为 API/channel 入口，不占 Coordinator helper 的 job 队列。`Decision.run.coordinator_ref` 保存会话引用，供 Card answer 恢复。没有配置 coordinator 时，New / Build 会明确报错，不会降级到 shepherdr Assistant。

## 状态与队列

- Decision 是唯一的持久状态机（`open / waiting / settled`）；Work 的 Needs you / Todo / Working / Settled 是投影，不写回 Ledger。
- 队列只有 `waiting` 的 Decision；Todo / Working 不是队列。
- `~/.local/state/collie/queue.json` 是 Ledger 投影，含全部 Decision，**不是**队列本身。
- `Settled` 只认 `Decision.settled { at, by, outcome }`；`failed` 带卡，属于 Needs you；`ack` 不等于 settled。
- review 工作必须由 coordinator 写 `Decision.run.kind="review"`；没有这个字段时，它按 build 显示。
- 用户 policy 放在 `~/.local/state/collie/policy/<space>.md`（没有时读 `policy.md`），coordinator 只读。

## Card answer

验收与选择走 Card answer（不经过 shepherdr 原生 Accept）：

```bash
~/.config/herdr-app/bin/collie-answer --decision dc_xxx --option accept
~/.config/herdr-app/bin/collie-answer --decision dc_xxx --option rework --note "..." --file path --line N
~/.config/herdr-app/bin/collie-answer --decision dc_xxx --option drop
~/.config/herdr-app/bin/collie-answer --decision dc_xxx --option later --snooze 2026-11-18T09:00:00Z
```

- `accept / rework` 需要该 space 有且只有一个可用的 coordinator；`drop / later` 不需要。
- `accept` 把 Decision 推进到 `open`，恢复原 coordinator 会话；合并/评论由 coordinator 的 delivery 决定，完成后才 `settled`。
- `drop` 直接 `settled{dropped}`；`later` 保持 `waiting`。
- 打开/展开只是 `ack`，不会结案；只有 Card answer 的 outcome 才结案。

## Secrets

`collie-secret` 让 agent 按名字用密钥，值不进口语、日志或 artifact。保险库在 `~/.local/share/collie/secrets/vault.json`（目录 0700、文件 0600；`COLLIE_SECRETS_HOME` 可改位置），与 chat 的 ask card 写的是同一个文件。

```bash
# agent（在其 Collie 终端里）
collie-secret ask GITHUB_TOKEN --why "push the branch"   # 在 chat 里留一张掩码卡，然后结束本轮
collie-secret list                                       # 能用的名字
collie-secret run GITHUB_TOKEN -- git push               # 值只在命令环境里，输出中的值被替换成 [GITHUB_TOKEN hidden]

# 人
printf '%s\n' "$VALUE" | collie-secret set GITHUB_TOKEN --why "push the branch"
collie-secret names --json                               # 只有名字、why、时间，没有值
collie-secret rm GITHUB_TOKEN
```

- `helper` 只有 `hidden` / `visible`：`helper` terminal 存活时，Coordinator pane 的 `Chat | Terminal | Helper` 会出现 Helper 页；切到 Helper 时 helper 占用当前 pane slot，切走时回到 parked（继续接收 ingress）。没有 `off`。space 下的 `coordinator.helper` 覆盖 Everywhere。
- helper 的 job / Decision 在 `$HOME/.local/state/collie/helper/<space>/{jobs,decisions}/`；这是交互式 agent 没有 stdout 时的文件 IPC。service 校验 Decision 后写 Ledger，helper 自己不能写 Ledger/policy，也不能直接 spawn。
- 找不到 Coordinator terminal、helper 启动失败或 120 秒内没有 Decision 时，事件变成 waiting Card；不会退回每个事件起一次 CLI。
- `ask` 只把 `collie.secret.ask.NAME=<why>` 留在该终端上；chat 的卡片（`mods/collie-chat/secret-card.js`）保存后回报 agent「Kept: NAME」，agent 再按名字用。
- 值短于 4 个字符不掩码（否则会把输出里每个字母都替换掉）。
- 与 shepherdr 的 `herdr-secret` 相比，机器级别（Everywhere / 某台机器 / 某个 space）、远端保管与 FIFO 应答（`serve` / `install --on` / `mark-remote` / `where`）、`env` 子命令都没有移植。

## Coordinator 生命周期与恢复

Coordinator 参考 shepherdr 的 Assistant，但尽量只依赖 herdr-core：

- 每个 space 一个 coordinator，tab 固定在最前。
- tab 里先是一个 chat pane，没有 agent；第一条消息才启动。
- agent 是普通 kept terminal：`hc run --bg --no-parent --keep`，停在 chat pane 后面。
- app 关闭不会杀 coordinator；herdr-core 会保活终端。
- 电脑关机后，开机由 herdr-core 拉起终端；agent 丢失时由 tick/revive 原地恢复。

恢复语义：

- live coordinator 直接接管，不重复启动。
- 持续记录原 argv、cwd、session 和 log。
- kept terminal 退回 shell 时，在同一 terminal 恢复原 session。
- session log 不存在时新建 session，并带 handover，不伪造恢复成功。
- 恢复由 `collie-task tick` 触发：service 在时由 service 每 15 秒 tick；service 不在时窗口自己 tick。
- 普通关闭 Coordinator Tab 不能直接 `tab.settle`；有 worker 时问 stop/keep，无 worker 也只会关 tab。
- 停止就是显式关闭 tab，或 `hc rm` 掉终端；没有 `collie coordinator stop`，因为 service 不做 auto-ensure。
- 没有 `collie coordinator ensure`；终端被删后不自动重建，人重新打开 coordinator tab。

运行时观察：

```sh
collie status
collie service status
herdr-app ls
hc get <coordinator>
hc ls --label herdr.role=helper --label herdr.job.space=<space>
hc read collie-helper-<space>
```

`collie doctor` 只检查安装完整性；`collie status` 才看运行状态。`collie-supervisor` 整个删除，不保留公共命令或内部入口。

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

`lib/<file>` 和 `core/<file>` 是唯一源；`lib/COPIES` 声明哪些 mod 需要副本。不要直接改 `mods/<mod>/lib/` 或 `mods/<mod>/core/` 里的副本。

```sh
bin/collie-sync --check   # 只检查，漂移返回 1
bin/collie-sync           # 同步
bin/collie-sync --check
```

- `lib/<file>` → `mods/<mod>/lib/<file>`；`core/<file>` → `mods/<mod>/core/<file>`。
- 手改过的副本不会被静默覆盖；用 `bin/collie-sync --from <copy>` 把它提升为源。
- `lib/.last/` 记录上次写入内容，已加入 `.gitignore`；安装器不会复制它。
- `--dry-run` 只打印计划；源码 checkout 和 herdr-app 自动识别 root，`.local/bin` 的 helper 默认使用 `$HOME/.config/herdr-app`。
- 隔离 root 显式传 `--root "$ROOT/.config/herdr-app"`。

## 常见故障

| 症状 | 检查 |
| :-- | :-- |
| 安装前报缺依赖 | `PATH`、shepherdr 版本、`chat` mod 是否存在 |
| 报 unmanaged file differs | 确认文件归属；需要接管时显式加 `--adopt` |
| doctor 报 modified | 文件已偏离 manifest；保留修改或人工恢复，不直接重跑覆盖 |
| doctor 报 pending update | 处理对应 `.new`，不要删除原文件 |
| update 报 source unavailable | 恢复 manifest 中的源码 checkout；不要另换来源静默更新 |
| layout mod 缺失 | 重装 collie（layout 的 mod 都在 `addons.json` 的 `mods` 里），或先修复本包 layout 与 mod 的交付完整性 |
| review 工作被当成 build 显示 | coordinator 没写 `Decision.run.kind="review"`；补上后 Work 显示 `kind=review` |
| Accept 后停在 Working | coordinator 未恢复或没有可用的 coordinator；检查 `collie-answer` 的 assistant 解析与 coordinator 会话 |
| `Settled` 数量不对 | 检查 Decision 是否真的带 `settled`；`failed` 与 `ack` 都不算 |
