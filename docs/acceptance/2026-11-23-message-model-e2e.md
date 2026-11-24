# 2026-11-23 · Message model / catalog / E2E

## 已完成

- Case 只保留 `origin: event | human`，移除 `stream` / `wake` / `visibility`。
- 预算按 `origin=event` 计算，human message 不计事件预算。
- Coordinator catalog 只注入 playbooks：`{ name, description, version }`。
- Driver brief 注入 `## Role catalog`。
- Role / Playbook frontmatter 统一为 `name` / `description` / `version`。
- Coordinator chat prompt 明确要求通过：
  - `collie ticket create`
  - `collie decision commit`
  - `collie roles list`
- `collie` 安装到 `.local/bin/collie`；`collie task` 的 `--root` 解析已修复。
- `collie-coordinator` legacy template 引用已移除，Coordinator 使用 `coordinator.md`。
- 现有 task store 已清空（备份见执行时 `/tmp/collie-task-backup-*`）。

## E2E · flume → helper

实际通过 flume HTTP `/gitlab` 投递，flume 使用 feed exec 调用：

```text
collie intake event --space spf57...
```

结果：

- Ledger event `collie-e2e-flume-http-1001`
- Case `ca_d70b978ccca54e69`
- Decision `gitlab:collie-e2e-flume-http-1001`
- Coordinator helper `t9t` 处理，Decision 为 `settled` / `noop`
- 直接 CLI intake 也得到 `event 83` / `case 84` / `decision 85-86`

## E2E · human Coordinator → task

历史上通过 `collie-request` 发出 human message（该入口已删除，现由 Coordinator chat 公开命令落库）：

- task `SW-74`（folder `/Users/mi/work/system-weaver`）
- driver terminal `t105`（`sw-74-collie-readme`）
- reviewer helper `t106`（`sw-74-review`）
- second reviewer `t107`（`sw-74-review2`）
- task settings：Review on、Reviewer codex、Proof on、Merge ask
- task 初始状态 `running`；driver `t105` 启动 reviewer `t106`，读取 report 后启动第二轮 reviewer `t107`
- task 最终 `ready`，两轮 review 都有记录：
  - round 1：6 majors（README 实现偏差）
  - round 2：2 majors + 3 minor
- service 收到 receipt `rc_8660c38f4ab04699`，Decision `dc_6cd4182910cd42f4` 进入 `waiting`，生成 accept Card
- 任务完成后已从 task store 清除（`collie task rm ... 74`）

## 验证

- `npm test`：102 tests 通过
- `collie doctor`：all checks passed
- `hc templates`：`coordinator` / `driver` 正常
- `collie roles list` / `collie task list` 可用
- 最终 task store：`miergo: 0`, `system-weaver: 0`

## 追加 · Message envelope 与真实 Coordinator chat

### Message envelope

- `protocol/message.schema.json`（`urn:collie:message:v1`）成为独立信封。
- human 路径只写 Ledger `message`，不再写合成 Event：
  - `request`
  - `createTicket`
  - `commitDecision`
  - `adoptTicket`
- Decision 身份字段由 kernel 固定：`id`、`key`、`space`、`event_ref`、`case_ref`、`occurrence`、`origin` 不接受 Coordinator 输出覆盖。
- human Decision：`event_ref=null`，`key` 为单前缀的 `human:turn:*`；occurrence 绑定 `none:msg_*`。

### 真实 Coordinator chat（t9s）

通过 `hc send` 驱动 Coordinator tab 背后的真实 agent：

- `collie roles list` 返回 4 roles / 8 playbooks，feature 标记 `verify: true`。
- `collie decision commit` 写入 settled Decision：
  - `dc_0c5abab5b36f41ea`
  - `key=human:turn:chat-e2e-3`
  - `event_ref=null`
  - `space_candidates=[spf57...]`
- `collie ticket create` 产生 task `COLL-1`，task brief 以 `处理 Message human.ticket_requested` 开头；验证后已 `collie-task rm`，Decision 已 settled/dropped。
- 期间发现并修复：`--brief` 只把参数当文件路径，内联文本直接 traceback；现在存在文件则读文件，否则按文本处理，并加 CLI 回归测试。

### Helper pane

- park `t9t` 后切回 Coordinator，chat 的 helper watcher 自动 `terminal.keep`，Helper tab 重建并显示 `t9t`。
- 打开动作从 render 内移出，改为 `init` 后的 5 秒定时检查，避免渲染期间发命令。

### 验证

- `npm test`：104 tests 通过
- `collie doctor`：all checks passed
- `collie service status`：`ok=true`（顺带修复 health 响应 chunked 导致 CLI 解析失败：现在发送 `content-length`）
- task store：`collie: 0`，`miergo: 0`

### 已知限制

- Coordinator tab 的 chat pane 在这次 300+ turn 的长历史上会触发 Herdr 的 50ms render 超时，界面显示 “This view could not be re-rendered”。同一会话的 terminal 与命令路径正常；这是渲染性能问题，不是 Message / Decision 逻辑失败。Helper tab 与 Inbox 渲染正常。

## 追加 · Card accept 后执行出站动作

- `answerCard` 在 `option=accept` 且 Decision 仍为 `open`、含 `emit_command` 时自动调用 `deliver`。
- 新增 `POST /deliver` 和 `collie decision deliver --decision <id>`，用于 delivery 失败重试。
- `test/service.test.ts` 覆盖：accept 后外部命令恰好执行一次，Decision 直接 `settled{outcome:"commented"}`。
- `collie-answer` 优先使用 `Decision.run.coordinator_ref`，没有再按 workspace folder 找唯一 Assistant。

## 追加 · 运行时闭环与 review 场景

### 已完成

- `nextHops()`：spawn 递增 hops，超限转 alert Card。
- `priority` / `hold` / `propose_policy` 投影到 Decision；priority 第 3 次转 approval Card。
- task 未 ready 结束时写 waiting alert Card，不把异常抛回 ingress。
- 多 `space_candidates` 生成 waiting Card，不静默选边。
- `queue.json` 由 service 启动时从 Ledger 重建。
- 未完成 helper job 在 service 重启后转 waiting Card。
- review 场景集成测试：`running → ready`，验证 receipt_ref、Card 和 Inbox 的 Needs you 投影。

### 验证

```text
npm test          117 passed
collie doctor     all checks passed
review scenario test  passed
```

### 实机限制

本次没有重新创建真实 review 场景做 UI 端到端。
review 状态测试是 service + fake task runner 的集成测试，覆盖状态机与 receipt 投影，不覆盖真实 agent 的评论动作。
