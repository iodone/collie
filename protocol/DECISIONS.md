# DECISIONS · M0 遗留的六条判断

> 本文件只记「schema 现在已经怎么表达、还缺什么、建议怎么定」。**所有条目状态都是 `[待主人确认]`**——这些是协议层面的判断，不由实现方自行拍板。
> 依据：`docs/DESIGN.md` §10 与 `protocol/README.md` §五。判据不在这里复制。

| # | 建议 | 理由一句 | 影响面 | 状态 |
|:--|:--|:--|:--|:--|
| 1 | `brief_ref` 由**内核**渲染，`spawn` 不新增渲染者字段 | 指令数据分离需要一个「不进模型」的入口；让 coordinator 渲染，等于把模板交回它 | `Decision.actions[].spawn`；M1 已按此实现（`renderBrief`） | `[待主人确认]` |
| 2 | coordinator 的记忆放 Ledger，按 **space** 取最近 10 条 | 与「判断按 space 切、队列只一份」同构；放会话里则重启即失忆 | `Case.memory.ledger_ref` + `snapshot.recent[]` | `[待主人确认]` |
| 3 | `snooze` 独立成 `Card.snooze_until`，**到期只重排队、不重算 hops** | 借用 `herdr-task.scheduled` 会把「人推迟」与「机器排期」混成一个字段 | `Decision.card.snooze_until` | `[待主人确认]` |
| 4 | `propose_rule` **也走卡片**（`card.kind="question"`） | 它改的是以后所有判断，比单次决定的影响面大 | `Decision.proposal` + Card | `[待主人确认]` |
| 5 | 多 space 时用 `space.primary` 定归属、`space_candidates` 记候选、`resolution` 记依据；**记住的答案落 `~/.local/state/collie/space-map.json`，那是事实，不进路由表** | 事实与判断必须分开：`space-map.json` 记录「这个 repo 属于哪个 space」的观测结果，路由表记录「这类事件该谁干」的规则 | `Event.space_candidates` / `Case.space` / `Decision.space*`；M1 的 `resolveSpace()` 已按此实现 | `[待主人确认]` |
| 6 | agentinbox **v1 不引入** | 它的「一源多 agent 各自 ack」与单机单判断者的 Ledger 重复；等出现第二台机器再谈 | 无字段变化 | `[待主人确认]` |

## 附：两条实现层的已知坑（已修，记录备查）

1. **校验器参数顺序是 `validate(data, target)`**，`target` 是 `$id` 或 schema 对象。写反（`validate(id, data)`）不会报错，而会把 data 当 schema 用、**永远返回 0 个错误**——这正是「检查器没报警不等于没错」的一个具体实例。M1 的单测已按正确顺序调用，并靠「故意注入违规必须报错」锁住这一点。
2. **标题会进 argv**（`herdr-task add <title>`）。`plugins/agent/herdr.ts` 的 `sanitizeTitle()` 去掉 `$`、反引号、`{}`、`<>`、`|`、`;`、`&` 等会改变 shell 语义的字符，且不许以 `-` 开头（否则会被当成选项）。这是 DESIGN §5.4 `isTitle` 铁律在代码里的落点。
