// protocol/constants.mjs
// M0 冻结的数值常量。ARCHITECTURE.md 是语义真源，这里是它的可执行镜像：
// 任何一处改动都必须同时在 docs/ARCHITECTURE.md 留下痕迹。

/** DESIGN §7.3 / §9：委派层数上限。> 8 只记录、不再派发。 */
export const MAX_HOPS = 8;

/**
 * DESIGN §3.2："经过人的卡片也不清零"。
 * 常量取 false 而不是省略——它是判据，不是实现细节。
 */
export const HOPS_RESET_ON_CARD = false;

/** DESIGN §3.2 / §9：每小时唤醒预算，**全局**一份（不按 space 切）。 */
export const BUDGET_PER_HOUR = 6;
export const BUDGET_WINDOW_MINUTES = 60;

/** DESIGN §9：同一 object 24h 内 priority 最多改 2 次，第 3 次必须出卡。 */
export const PRIORITY_MAX_CHANGES_PER_24H = 2;
export const PRIORITY_WINDOW_HOURS = 24;

/** DESIGN §3.2：护栏七条。顺序即编号，rule 不可删减、不可替换。 */
export const ASK_FIRST = Object.freeze([
  "delete_data",        // 删数据
  "stop_service",       // 停服
  "spend_money",        // 花钱
  "outbound_message",   // 对外发消息
  "product_direction",  // 改产品方向
  "rotate_secret",      // 新建或轮换密钥
  "change_permission",  // 修改权限
]);

/** DESIGN §3.3：Decision 状态机。Card = state=waiting 的 Decision。 */
export const DECISION_STATES = Object.freeze(["open", "waiting", "settled"]);

/** 终态：进入后不再派发。settled 必须有 settled 对象。 */
export const TERMINAL_STATES = Object.freeze(["settled"]);

/** DESIGN §4.1：卡片三态。decided 只说明人表过态，不等于执行过。 */
export const CARD_STATES = Object.freeze(["open", "decided", "closed"]);

/** DESIGN §4.1：人对卡片的四种回答。 */
export const CARD_OPTIONS = Object.freeze(["accept", "rework", "drop", "later"]);

/** 卡片用途。approval 只能由 guard 产生；alert 承载失败。 */
export const CARD_KINDS = Object.freeze(["approval", "accept", "question", "alert"]);

/** DESIGN §4.2：任务状态归 herdr-task，本设计一个字都不改。 */
export const TASK_STATES = Object.freeze([
  "todo",
  "queued",
  "working",
  "ready",
  "merging",
  "done",
]);

/** DESIGN §3.2 / §9：交给 coordinator 的快照上限，内核拼，它不能自己扩大视野。 */
export const SNAPSHOT_BYTES_MAX = 4096;

/** DESIGN §3.2：喂给 coordinator 的最近决定条数（防抖 + 记忆外置）。 */
export const RECENT_DECISIONS_MAX = 10;

/** DESIGN §3.2：事件来源。四个都必须是可替换的缝。 */
export const EVENT_SOURCES = Object.freeze(["gitlab", "github", "cron", "im"]);

/** DESIGN §3.1：事件绑定的对象种类。none = 无对象（cron / im）。 */
export const OBJECT_KINDS = Object.freeze(["mr", "issue", "pipeline", "none"]);

/** Decision.actions[].kind：五种动作 + noop。**没有 chat_message 这一类。** */
export const ACTION_KINDS = Object.freeze([
  "spawn_task",
  "emit_command",
  "ask",
  "hold",
  "priority",
  "propose_policy",
  "noop",
]);
