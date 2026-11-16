# protocol/ · M0 冻结层

这里是 [`../docs/DESIGN.md`](../docs/DESIGN.md) 的可执行形态：**七个 JSON Schema + 一个不变量模块 + 一个校验器 + 54 条单测**。

它不解释「为什么这么设计」。判据、权衡、图都在 DESIGN 里，本文只做索引：哪个对象是什么、谁写谁读、活多久、哪条不变量落在哪个函数、哪些问题还没定。

```
protocol/
  constants.mjs          # 数值冻结：8 跳 / 6 次 / 2 次 / 七条 / 4KB
  event.schema.json      # Event
  rule.schema.json       # Rule（路由表的一条）
  ruleset.schema.json    # Ruleset（规则集文件：护栏 + 预算 + 上限 + rules[]）
  case.schema.json       # Case（交给 coordinator 的一次 job turn）
  decision.schema.json   # Decision（含 $defs/card、$defs/action）
  card.schema.json       # Card = Decision{state:"waiting"}，不新增字段
  receipt.schema.json    # Receipt（herdr-task ready 三件套）
  validate.mjs           # draft 2020-12 子集校验器 + schema 卫生检查
  invariants.mjs         # DESIGN §7 不变量的可执行形态
  fixtures/*.json        # 每个对象一份合法样例（单测的 happy path）
  test/*.test.mjs        # node --test
```

跑测试：

```bash
cd projects/collie
node --test protocol/test/*.test.mjs      # 或 pnpm test / npm test
```

## 一、七个对象

| 对象 | 一句话 | 谁生产 | 谁消费 | 生命周期 |
|:--|:--|:--|:--|:--|
| **Event** | 外部发生的一个事实，去重后不可变，正文只以 `data_ref` 指路径 | `plugins/source/*`（Ingress） | 归并层、coordinator（经 Case）、Ledger 回放 | 到达即写，写后不改；超过 8 跳也只记录、不再派发 |
| **Rule** | 路由表的一条：什么样的 `type` 交给谁、在哪干、什么权限 | 人（`mods/collie-rules`） | Ingress（命中即跳过模型） | 人改则 `Ruleset.version` +1；可 `paused` 而不删 |
| **Ruleset** | 规则集文件，同时承载**不可下放**的三样：护栏七条、全局预算、跳数/调序上限 | 人（Everywhere only） | Ingress、内核、guard | 与 Rule 同生命周期；版本号进每份快照 |
| **Case** | 递交给 coordinator 的一次 job turn：活事件 + ≤4KB 快照 | 内核（Ingress/归并层） | 该 space 的 coordinator | 只在 Ledger；`visibility=ledger_only`，**永不进 chat**；一次唤醒计一次预算 |
| **Decision** | 对一件事件的判断：干什么、为什么（`why` ≤140 字） | coordinator 或路由表；人可改判 | 内核（派发/出站）、mods（渲染队列）、IM、Ledger 记忆 | 状态机 8 态；终态只能由 `settled` 打开 |
| **Card** | `Decision{state:"waiting"}` 的人面投影，字段定义只有一处 | 内核（由 guard 或 coordinator 触发） | `mods/collie` 队列、channel 插件 | `open → decided →（decision 推进）` 或 `open → closed`；`decided` 只说明人表过态 |
| **Receipt** | 任务交回来的回执：`ready` 的 summary/details/proof 三件套 + 风险信号 | `plugins/agent/herdr.ts`（听 herdr-task ready） | coordinator（决定自动接受还是要 Accept 卡） | 一次 ready 一条；不进人的对话，只进 Ledger 与卡片的凭据区 |

三个投影关系，别在实现时搞混：

- **Card 不是第四个对象**：`card.schema.json` 只做一次 `const` 收窄到 `state:"waiting"`，卡片字段住在 `decision.schema.json#/$defs/card`。
- **Queue 不是对象**：它是「所有 `state=waiting` 的 Decision 按 priority 排」，由 mod 现算，不落库。
- **Task 不在本目录**：任务状态归 `herdr-task`，schema 只存 `receipt_ref` 与 `receipt.task` 快照。

## 二、字段只有一个写者

DESIGN §7.6「两份真相比没有真相更糟」。落到字段级：

| 字段 | 唯一写者 | 只读者 |
|:--|:--|:--|
| `Event.*` | Ingress | 其余全部 |
| `Ruleset.*` | 人 | Ingress / 内核 / guard |
| `Case.snapshot` | 内核（`scope.forbidden_expand=true` 禁止 coordinator 自己 git/gh 补上下文） | coordinator |
| `Decision.state` / `why` / `actions` | coordinator 或路由表 | 内核、mods、IM |
| `Decision.risk` | **guard**（`applyGuard`） | 内核、卡片 |
| `Decision.occurrence.hops` | `nextHops` / `answerCard`（后者保持不变） | guard、内核 |
| `Decision.ack` | channel（人展开卡片时） | — |
| `Decision.settled` | `settle()`（人、coordinator 或 expiry） | — |
| `Card.answer` | 人（经 channel） | 内核（据此推进 decision） |
| `Receipt.*` | `plugins/agent/herdr.ts` | coordinator |

`ack` 与 `settled` 是两列、两个写者、两种语义：看到 ≠ 处理完。这条不只是注释——`isSettled()` 在 `settled` 已写而状态不是终态时直接抛错，`markAcked()` 在返回前断言 `state`、`settled` 都没被改动。

## 三、不变量 → 函数

| DESIGN §7 | 可执行形态 | 单测里怎么证伪 |
|:--|:--|:--|
| 7.3 跳数熔断 | `checkHops` / `nextHops` / `answerCard` | 8 跳放行、9 跳 `record_only`；卡答完 hops 不变 |
| 3.2 唤醒预算 | `checkBudget` / `usedBudget` / `admitCase` | 6 次用完第 7 次 `degrade_to_card`；三个 space 合计计数；chat turn 不计数 |
| §9 判断抖 | `checkPriorityChange` / `priorityChanges` | 第 3 次 `requires_card=true`；`via_card` 才放行；别的 object / 24h 外不计 |
| 3.2 护栏七条 | `assertRulesetGuard` / `guardHits` / `applyGuard` | 七条逐条命中都落到 waiting+approval；自称无风险无效；`guard_bypass` 字段 schema 直接拒 |
| ack ≠ settled | `markAcked` / `settle` / `isAcked` / `isSettled` / `assertAckSettledDistinct` | ack 后 `state`/`settled` 不变；无 outcome 结不了账 |
| 7.2 指令数据分离 | `checkEventAcceptable` | 事件带 `cwd/agent/access` 拒收；`data_ref` 必须绝对路径 |
| 7.1 事件溯源 | **不在 M0**：靠 M3 的 append-only Ledger + 索引重建 | schema 只保证 id/时间字段与不可变字段齐全 |
| 7.4 挂起零消耗 | **不在 M0**：靠 Case/Memory 的形状（等人时没有进程） | 形状证据：`Case.memory.ledger_ref` 是唯一记忆入口 |
| 7.5 单一判断者 | `applyGuard` 无条件执行 | 规则写 `tells:never`、coordinator 写 `state:routed` 都改不动判定 |

`applyGuard` 的第三个参数 `authoritative.hops` 是唯一允许内核覆写 coordinator 输出的入口——它存在的理由就是 DESIGN §7.3 那句「agent 改不了」。

## 四、三处「照抄 agent-autoloop 会坏」落在哪

| 会坏的地方 | 落在哪个字段 | 怎么坏不起来 |
|:--|:--|:--|
| 长任务期间 `unknown` 是正常态 | `Decision.run.unknown_policy`（const `normal`）+ `Receipt.progress.basis`（const `task_state_advance`）+ `Case.snapshot.running[].state/state_changed_at` | 判据被 schema 冻成「状态有没有前进」；`judgeProgress` 的四种返回里 `is_failure` 恒为 `false`，`stalled` 只意味着该出卡 |
| coordinator 的 `cwd` 可以是非 git 状态目录 | `Rule.to.cwd.kind`（`git` / `state`）+ `Rule.to.cwd.path` | `kind:"state"` 合法，路径必须绝对；不需要 git 也能当 coordinator 的 cwd |
| 回执不是最后一条消息 | `Receipt.origin`（const `herdr-task ready`）、`Receipt.last_message_used`（const `false`）、`proof.refs`（≥1）、`review.reviewed`（const `true`） | 没有凭据锚点、没记录复核的 ready 直接校验失败；`last_message_used:true` 校验失败 |

## 五、DESIGN §10 六条开放问题：当前表达 / 还缺什么 / 建议

1. **`brief_ref` 谁渲染** — 表达：`Decision.actions[].spawn.brief_ref` 只有绝对路径，没有渲染者字段。还缺：渲染者的唯一真源（内核 or coordinator）。建议：内核渲染，理由是指令数据分离需要一个不进模型的入口；若主人选 coordinator，就在 `spawn` 加 `brief_rendered_by`。
2. **coordinator 的记忆放哪** — 表达：`Case.memory.ledger_ref` + `snapshot.recent[]`（≤10 条，实体在 Ledger）；`Decision.why` 是记忆的原子。还缺：`recent` 的选取策略（按 space 还是按 object）。建议：Ledger，按 space 取最近 10 条，与 DESIGN 一致。
3. **`snooze` 与 `herdr-task.scheduled` 不同义** — 表达：`Card.snooze_until` 独立存在，不借用任务字段。还缺：到期后的动作（重新递 Case 还是直接重排队）。建议：新增 `snooze_until` 已足够，到期只重排队、不重算 hops。
4. **`propose_rule` 是否也走卡片** — 表达：`Decision.actions[].kind=propose_rule` + `Decision.proposal{draft_ref,summary}`，**当前不强制出卡**。还缺：一条判断「这条规则要不要人点头」。建议：走卡（`card.kind="question"`），因为它改的是以后所有判断。
5. **一个事件影响两个 space 归谁** — 表达：`Event.space_candidates[]`（Ingress 算出的候选）、`Case.space{primary,candidates,resolution}`、`Decision.space` + `Decision.space_candidates[]`；`resolution` 取值 `single|rule_table|remembered|card`。还缺：①记住答案的存放位置 ②多于一个候选时是否**一定**出卡。字段建议：主字段用 `primary_space`（现 schema 收在 `space.primary` / `Decision.space`，若要扁平命名就加 `primary_space` 别名并保持二者同值）；候选用 `space_candidates`；解算依据用 `resolution`。建议：folder→space 定 primary，命中多个 → 出一次卡并把答案记到 `~/.local/state/collie/space-map.json`（事实，不进路由表）。
6. **agentinbox 的定位** — 表达：schema 里没有任何 ack 队列字段，`Decision.ack` 只有单机一个写者。还缺：多机时的一源多 agent 是否要 reintroduce。建议：v1 不引入；等出现第二台机器再谈。

## 六、[冲突] DESIGN 自身对不齐的地方（**已按 A 写回 DESIGN**）

> 2026-11-16：四处冲突全部按下面标注的 **A** 方案写回 `docs/DESIGN.md`，并各带一行「为什么不选 B」。
> 本节保留原始分析，作为「为什么是 A」的凭据；DESIGN 现在是唯一真源，两者口径已对齐。

**[冲突 1] Card 的三态 vs Decision 的状态机**
DESIGN §4.2 写「Card 的三态：`open → decided → done`」，但同一份文档说 Card 是 `Decision{state:"waiting"}`——若卡片 `done`，那条 Decision 已经不是 `waiting` 了，同一个 `state` 字段承载不了两套状态。
两种解法：**(A)** 卡片状态独立成 `card.state ∈ {open,decided,closed}`，执行结果由 `decision.state` 承载（**本 schema 采用 A**）；**(B)** 照字面保留 `done`，但必须给 `card.state` 与 `decision.state` 分别命名并写清同名不同义。A 的代价是 DESIGN 图里那个 `done` 要改成「decision 的终态」。

**[冲突 2] 「三对象」与任务要求的六 schema**
DESIGN §2 说「砍到只剩三个：Event / Decision / Task」，而 `Case`、`Receipt`、`Rule` 在这份文档里都有实义但不在清单里；`Task` 反而不在我们这层。
两种解法：**(A)** 把 `Case`/`Receipt` 当作 Ledger 的**信封**（不是领域对象），`Rule` 当作路由表条目，`Task` 明确留在 shepherdr（**本 schema 采用 A**，所以 `protocol/README.md` 开头叫它们「对象」但状态所有权表里只有 Event/Decision 是本层的）；**(B)** 把 DESIGN §2 改写成「三个领域对象 + 两个信封 + 一张表」。

**[冲突 3] `hops > 8` 要「只记录」 vs schema 的 `maximum`**
若 `Event.hops` 设 `maximum: 8`，9 跳事件就存不进去——而 DESIGN §7.3 要求它「只记录」。
两种解法：**(A)** schema 不设上界，熔断交给 `checkHops`（**本 schema 采用 A**，上界在 `constants.MAX_HOPS` 与 `Ruleset.max_hops` 里冻结为 8）；**(B)** 保留 `maximum:8`，另立一张 overflow 表存越界事件，代价是多一份状态。

**[冲突 4] 回执有两种描述**
DESIGN §2.1 说回执是「autoloop 回执块里的 `ask / notice / resolve / later`」，§2.2 说回执取 `herdr-task ready --summary/--details/--proof`。前者是内嵌决策的协议，后者是一次任务交付。
两种解法：**(A)** 采信 §2.2：`Receipt` 只承载交付三件套 + 风险信号，`ask/notice/later` 一律走 `Decision.actions`（**本 schema 采用 A**）；**(B)** 保留 autoloop 的回执代码块，让它与 herdr-task ready 并存，代价是同一件事有两个表达，卡片来源会不确定。

**[张力] 「每份状态一个写者」与人的回答**
DESIGN §5.6 把 Decision 的写者写成「coordinator / 路由表」，但卡片回答实际上由人产生。本 schema 的处理是：人只写 `Card.answer`，内核据此写 `Decision.state`——人写事实，内核写状态。若主人希望人直接写 Decision，就要在 §5.6 里补上「人的回答经 channel 写入」。

## 七、M0 做了什么、没做什么

做了：schema 冻结（无 `TBD`/`TODO`/空 `description`，由 `checkHygiene` 强制）、不变量函数、54 条单测、校验器自检。

M0 只冻结协议，不包含运行时。后续里程碑已在 `plugins/`、`kernel/`、`mods/`、`service/` 与安装器中实现；Ledger 的物理落盘格式由 `kernel/ledger.ts` 管理，不属于本协议目录。
