// protocol/invariants.mjs
// ARCHITECTURE.md §9「不变量」的可执行形态。这里没有散文，只有函数——
// 每个函数都是纯函数：输入对象、输出判定，不写库、不联网、不看时钟（now 由调用方传入）。
//
// 对应关系（README.md 里也列了同一张表）：
//   §7.1 事件溯源        → 由 Ledger 保证（M3），M0 只提供 append-only 的 id/时间字段约束
//   §7.2 指令数据分离    → checkEventAcceptable / applyGuard（覆盖来源自填字段）
//   §7.3 跳数熔断        → checkHops / nextHops / answerCard
//   §7.4 挂起零消耗      → 由「Ledger 是记忆」这一形状保证（Case.memory）
//   §7.5 单一判断者      → applyGuard（护栏绕过 coordinator 的判决）
//   §7.6 单一写者        → 每个字段只有一个函数会写它（见 README 的字段-写者表）

import {
  ASK_FIRST,
  BUDGET_PER_HOUR,
  BUDGET_WINDOW_MINUTES,
  CARD_OPTIONS,
  HOPS_RESET_ON_CARD,
  MAX_HOPS,
  PRIORITY_MAX_CHANGES_PER_24H,
  PRIORITY_WINDOW_HOURS,
  TERMINAL_STATES,
} from "./constants.mjs";

const HOUR_MS = 60 * 60 * 1000;

function ms(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`时间格式非法: ${iso}`);
  return t;
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** 只接受这七条；其余一律视为「未知风险」，按最坏情况处理（不放过）。 */
export function isAskFirstTag(tag) {
  return ASK_FIRST.includes(tag);
}

// ─────────────────────────────────────────────────────────────
// §7.3 跳数熔断：hops ≤ 8，卡片回答不清零
// ─────────────────────────────────────────────────────────────

/**
 * 事件能不能继续派发。
 * DESIGN §7.3：> 8 只记录、不再派发，并发一张卡——所以这里不抛错，只给判定，
 * 调用方必须把 record_only 的事件写进 Ledger（拒收会丢证据）。
 */
export function checkHops(event, { max_hops = MAX_HOPS } = {}) {
  assert(event != null && typeof event === "object", "checkHops 需要事件对象");
  const hops = event.hops;
  assert(Number.isInteger(hops) && hops >= 0, `hops 必须是非负整数，实际 ${String(hops)}`);
  const dispatch = hops <= max_hops;
  return {
    hops,
    max_hops,
    dispatch,
    record_only: !dispatch,
    card_required: !dispatch,
    reason: dispatch ? "ok" : `hops ${hops} > ${max_hops}，只记录并出卡`,
  };
}

/**
 * 派发一个新任务：跳数 +1。唯一能增加 hops 的函数。
 * 返回 record_only 时调用方不得 spawn，只能出卡。
 */
export function nextHops(decision, { max_hops = MAX_HOPS } = {}) {
  assert(decision && decision.occurrence, "nextHops 需要带 occurrence 的 Decision");
  const hops = decision.occurrence.hops + 1;
  const dispatch = hops <= max_hops;
  return {
    hops,
    max_hops,
    dispatch,
    record_only: !dispatch,
    card_required: !dispatch,
    decision: {
      ...decision,
      occurrence: { ...decision.occurrence, hops },
    },
    reason: dispatch ? "ok" : `派生到第 ${hops} 跳已超过 ${max_hops}，只记录并出卡`,
  };
}

/**
 * 人对卡片的一次回答。
 * DESIGN §3.2「经过人的卡片也不清零」——这里把 hops 原样带过去，
 * 并在返回前断言没被改动。这是「卡片回答不能刷新跳数」的可执行版本。
 *
 * @param {object} decision state=waiting 的 Decision
 * @param {{option:string, at:string, by:string, annotations?:Array}} answer
 */
export function answerCard(decision, answer) {
  assert(decision && decision.card, "answerCard 需要 state=waiting 且带 card 的 Decision");
  assert(decision.state === "waiting", `只有 waiting 的决定能回答，实际 ${decision.state}`);
  assert(answer && CARD_OPTIONS.includes(answer.option), `非法选项 ${String(answer && answer.option)}`);
  assert(!decision.card.options || decision.card.options.includes(answer.option),
    `该卡片未提供选项 ${answer.option}`);
  if (answer.option === "rework") {
    assert(Array.isArray(answer.annotations) && answer.annotations.length > 0,
      "rework 必须带结构化批注：没有批注的 rework 等于一句「不对」");
  }

  const hopsBefore = decision.occurrence.hops;
  const nextState =
    answer.option === "drop" ? "settled" : answer.option === "later" ? "waiting" : "open";

  const cardState = answer.option === "drop" ? "closed" : answer.option === "later" ? "open" : "decided";

  const next = {
    ...decision,
    state: nextState,
    occurrence: { ...decision.occurrence, hops: hopsBefore }, // ← 不清零，也不推进
    card: {
      ...decision.card,
      state: cardState,
      answer: {
        option: answer.option,
        at: answer.at,
        by: answer.by,
        ...(answer.annotations ? { annotations: answer.annotations } : {}),
      },
      closed_at: answer.option === "drop" ? answer.at : decision.card.closed_at ?? null,
      snooze_until: answer.option === "later" ? answer.snooze_until ?? null : decision.card.snooze_until ?? null,
    },
  };

  if (answer.option === "drop") {
    next.settled = { at: answer.at, by: "human", outcome: "dropped" };
  }

  assert(next.occurrence.hops === hopsBefore,
    `卡片回答不得改变 hops（${hopsBefore} → ${next.occurrence.hops}）`);
  assert(HOPS_RESET_ON_CARD === false, "常量 HOPS_RESET_ON_CARD 被改成了非 false，与 DESIGN §3.2 冲突");
  return next;
}

// ─────────────────────────────────────────────────────────────
// §3.2 / §9 唤醒预算：全局一份，默认 6 次/小时
// ─────────────────────────────────────────────────────────────

/**
 * 窗口内已用的唤醒次数。**不按 space 分组**——这是 DESIGN §1.2「队列只有一份」的落点。
 * 只数 wake=true 的 Case（job turn）；人主动说话的 chat turn 不烧预算。
 */
export function usedBudget(cases, now, { window_minutes = BUDGET_WINDOW_MINUTES } = {}) {
  const end = ms(now);
  const start = end - window_minutes * 60 * 1000;
  return (cases || []).filter((c) => {
    if (!c || c.wake !== true) return false;
    if (c.stream !== undefined && c.stream !== "job_turn") return false;
    const t = ms(c.created_at);
    return t > start && t <= end;
  });
}

/**
 * 还能不能唤醒 coordinator。
 * 预算耗尽时唯一合法降级是「出卡等人」（DESIGN §9：超出降级为卡）。
 */
export function checkBudget(cases, now, { limit = BUDGET_PER_HOUR, window_minutes = BUDGET_WINDOW_MINUTES } = {}) {
  const end = ms(now);
  const inWindow = usedBudget(cases, now, { window_minutes });
  const used = inWindow.length;
  const remaining = Math.max(0, limit - used);
  const allowed = used < limit;
  const oldest = inWindow.length
    ? Math.min(...inWindow.map((c) => ms(c.created_at)))
    : end;
  return {
    scope: "global",
    limit,
    used,
    remaining,
    allowed,
    degrade_to_card: !allowed,
    window_minutes,
    window_start: new Date(end - window_minutes * 60 * 1000).toISOString(),
    window_end: new Date(end).toISOString(),
    reset_at: new Date(oldest + window_minutes * 60 * 1000).toISOString(),
  };
}

/**
 * 账本入口：预算不足时不许建 job turn 的 Case。
 * 返回 { allowed, case? , card_required } —— 调用方拿到 card_required 就必须出卡。
 */
export function admitCase(existingCases, candidate, now, opts) {
  const budget = checkBudget(existingCases, now, opts);
  const isWake = candidate && candidate.stream === "job_turn";
  if (!isWake) return { allowed: true, budget, card_required: false };
  if (budget.allowed) return { allowed: true, budget, card_required: false };
  return {
    allowed: false,
    budget,
    card_required: true,
    reason: `全局预算已用 ${budget.used}/${budget.limit}，不唤醒 coordinator，降级为卡片`,
  };
}

// ─────────────────────────────────────────────────────────────
// §9 判断抖：同一 object 24h 内 priority 最多改 2 次，第 3 次必须出卡
// ─────────────────────────────────────────────────────────────

/** 数出该对象在窗口内已经发生过的 priority 变更（只看已经落账的决定）。 */
export function priorityChanges(decisions, objectKey, now, { window_hours = PRIORITY_WINDOW_HOURS } = {}) {
  const end = ms(now);
  const start = end - window_hours * HOUR_MS;
  return (decisions || []).filter((d) => {
    if (!d || !d.occurrence || d.occurrence.object_key !== objectKey) return false;
    const t = ms(d.decided_at);
    if (!(t > start && t <= end)) return false;
    return (d.actions || []).some((a) => a && a.kind === "priority");
  });
}

/**
 * 第 3 次改变必须出卡——不是「禁止改」，是「改之前先叫人看一眼」。
 * via_card=true 表示这次变更是人从卡片上选的，允许越过后面的次数限制。
 */
export function checkPriorityChange(
  decisions,
  candidate,
  now,
  { max_changes = PRIORITY_MAX_CHANGES_PER_24H, window_hours = PRIORITY_WINDOW_HOURS, via_card = false } = {},
) {
  assert(candidate && candidate.occurrence, "checkPriorityChange 需要带 occurrence 的候选决定");
  const objectKey = candidate.occurrence.object_key;
  const history = priorityChanges(decisions, objectKey, now, { window_hours });
  const changesInWindow = history.length;
  const requiresCard = changesInWindow >= max_changes;
  return {
    object_key: objectKey,
    changes_in_window: changesInWindow,
    max_changes,
    window_hours,
    next_change_index: changesInWindow + 1,
    requires_card: requiresCard,
    allowed: !requiresCard || via_card,
    reason: requiresCard
      ? `该对象 ${window_hours}h 内已改 ${changesInWindow} 次 priority，第 ${changesInWindow + 1} 次必须出卡`
      : "ok",
  };
}

// ─────────────────────────────────────────────────────────────
// §7.5 单一判断者：护栏七条不可被规则或 coordinator 绕过
// ─────────────────────────────────────────────────────────────

/**
 * 从动作本身推出命中哪些护栏。
 * 关键点：**不读 decision.risk.tags**。那个字段是 applyGuard 的产物，
 * 让 coordinator 自填等于让它给自己判无罪。判据只看动作干了什么。
 */
export function guardHits(decision) {
  const hits = new Set();
  for (const action of (decision && decision.actions) || []) {
    if (!action) continue;
    for (const tag of action.risk_tags || []) hits.add(tag);
    if (action.kind === "emit_command" && action.egress) {
      // 对外可见的动作一律算「对外发消息」；merge/close 不在七条里，按 Accept 卡策略处理。
      if (action.egress.op === "comment" || action.egress.op === "notify") hits.add("outbound_message");
    }
    if (action.kind === "spawn_task" && action.spawn) {
      // full 权限等价于「什么都能干」：不给护栏留口子，按最坏情况处理。
      if (action.spawn.access === "full") hits.add("change_permission");
    }
  }
  // 未知 tag 按最坏情况算：宁可多叫一次人。
  for (const tag of hits) {
    if (!isAskFirstTag(tag)) return [...hits, tag];
  }
  return [...hits];
}

/** 规则集必须恰好带七条护栏。删一条、换一条、加一条都要当场炸。 */
export function assertRulesetGuard(ruleset) {
  assert(ruleset && Array.isArray(ruleset.ask_first), "规则集缺 ask_first");
  const got = ruleset.ask_first;
  assert(got.length === ASK_FIRST.length,
    `ask_first 必须恰好 ${ASK_FIRST.length} 条，实际 ${got.length}：护栏不可删减`);
  const gotSet = new Set(got);
  assert(gotSet.size === got.length, "ask_first 有重复项");
  for (const tag of ASK_FIRST) {
    assert(gotSet.has(tag), `ask_first 缺 ${tag}：护栏不可被规则削掉`);
  }
  for (const tag of gotSet) {
    assert(ASK_FIRST.includes(tag), `ask_first 出现未知项 ${tag}：护栏不可被规则扩展成自定义清单`);
  }
  return true;
}

/**
 * 护栏执行器。**在 decision 落账前无条件跑一遍**，输出才是权威。
 * 它做三件事：
 *  1. 命中七条 → 把 state 钉成 waiting，强制出 approval 卡（无视 tells/state/decided_by 的任何说法）
 *  2. 用 authoritative.hops 覆写 occurrence.hops（coordinator 改不了跳数）
 *  3. 重写 risk，使「自称没有风险」不能成立
 */
export function applyGuard(decision, ruleset, { authoritative = {} } = {}) {
  assertRulesetGuard(ruleset);
  assert(decision && typeof decision === "object", "applyGuard 需要 Decision");
  assert(decision.human_boundary && decision.human_boundary.chat_injection === false,
    "事件不能进人的对话：human_boundary.chat_injection 必须为 false");

  const hits = guardHits(decision);
  const forced = hits.length > 0;

  const occurrence = { ...(decision.occurrence || {}) };
  if (authoritative.hops !== undefined) occurrence.hops = authoritative.hops;

  const next = {
    ...decision,
    occurrence,
    risk: { tags: hits, forced_waiting: forced },
  };

  if (!forced) return { decision: next, hits, forced_waiting: false, reason: "ok" };

  // 命中护栏：无论 coordinator 原本写了什么，都落到 waiting + approval 卡。
  next.state = "waiting";
  next.human_boundary = { ...(next.human_boundary || {}), form: "card", chat_injection: false };
  const askAction = (next.actions || []).find((a) => a && a.kind === "ask");
  const question =
    (askAction && askAction.ask && askAction.ask.question) ||
    `这个动作命中护栏（${hits.join(" / ")}），需要你拍板`;
  const existingCard = next.card || {};
  next.card = {
    kind: "approval",
    question,
    options: existingCard.options && existingCard.options.length ? existingCard.options : ["accept", "drop"],
    state: "open",
    created_at: existingCard.created_at || decision.decided_at,
    acked_at: existingCard.acked_at ?? null,
    answer: existingCard.answer ?? null,
    snooze_until: existingCard.snooze_until ?? null,
    closed_at: existingCard.closed_at ?? null,
  };
  // 护栏一出，spawn 的 tells 不再是「不通知」——否则 notification 语义会吞掉审批。
  next.actions = (next.actions || []).map((a) =>
    a && a.kind === "spawn_task" && a.spawn ? { ...a, spawn: { ...a.spawn, tells: "needed" } } : a,
  );

  return {
    decision: next,
    hits,
    forced_waiting: true,
    reason: `命中护栏 ${hits.join(",")}，已钉在 waiting 并出 approval 卡`,
  };
}

// ─────────────────────────────────────────────────────────────
// ack ≠ settled：两个字段、两种语义、不可互推
// ─────────────────────────────────────────────────────────────

export function isAcked(decision) {
  return Boolean(decision && decision.ack);
}

/** settled 只在「有 settled 对象且 state 已是终态」时成立。 */
export function isSettled(decision) {
  if (!decision || !decision.settled) return false;
  if (!TERMINAL_STATES.includes(decision.state)) {
    throw new Error(`settled 已写但 state=${decision.state} 不是终态：两份真相比没有真相更糟`);
  }
  return true;
}

/**
 * 记一次「人看过了」。**只写 ack**：不动 state、不写 settled、不释放队列。
 * 这是 DESIGN §0 第 2 个病（ack 被当成 settle）的结构性修复。
 */
export function markAcked(decision, { at, by, expectedState } = {}) {
  assert(decision, "markAcked 需要 Decision");
  if (expectedState !== undefined) {
    assert(decision.state === expectedState, `ack 不改变状态：期望 ${expectedState}，实际 ${decision.state}`);
  }
  const next = { ...decision, ack: { at, by } };
  assert(next.state === decision.state, "ack 不得改变 state");
  assert(next.settled === decision.settled, "ack 不得产生或清除 settled");
  return next;
}

/**
 * 结掉一个决定。只有它能写 settled、只有它能把 state 推进到终态。
 * 刻意不接收 ack 作为输入：要结就明确给 outcome。
 */
export function settle(decision, { at, by, outcome }) {
  assert(decision, "settle 需要 Decision");
  assert(["coordinator", "human", "expiry"].includes(by), `非法 settle.by: ${String(by)}`);
  assert(
    ["accepted", "merged", "commented", "superseded", "dropped", "expired", "failed"].includes(outcome),
    `非法 settle.outcome: ${String(outcome)}`,
  );
  return {
    ...decision,
    state: "settled",
    settled: { at, by, outcome },
  };
}

/** 形状自检：ack 与 settled 不能互相证明。返回不变量清单结果，供测试直接断言。 */
export function assertAckSettledDistinct(decision) {
  const acked = isAcked(decision);
  const settled = isSettled(decision);
  if (acked && !settled) {
    assert(!("settled" in decision) || decision.settled === null,
      "只有 ack 时不得存在 settled");
  }
  if (settled) {
    assert(decision.settled.outcome, "settled 必须带 outcome，不能由 ack 推导");
  }
  return { acked, settled };
}

// ─────────────────────────────────────────────────────────────
// 照抄 agent-autoloop 会坏的第 1 处：长任务期间 unknown 是正常态
// ─────────────────────────────────────────────────────────────

/**
 * 判断一个任务「还活着吗」。
 * 判据冻结为 task 状态有没有前进（Receipt.progress.basis = task_state_advance），
 * 不是进程在不在——长任务一小时没进展是正常态，不是 failed。
 *
 * @param {object} receipt Receipt（或带 task/progress 的最小对象）
 * @param {string} now ISO 时间
 * @param {{idle_ok_minutes?:number}} opts 多久没进展才算 stalled
 */
export function judgeProgress(receipt, now, { idle_ok_minutes = 90 } = {}) {
  assert(receipt && receipt.task, "judgeProgress 需要 Receipt");
  const stateChangedAt = ms(receipt.task.state_changed_at);
  const idleMinutes = (ms(now) - stateChangedAt) / 60000;
  const advanced = Boolean(receipt.progress && receipt.progress.advanced);
  let verdict;
  if (advanced) verdict = "advanced";
  else if (idleMinutes < idle_ok_minutes) verdict = "idle_normal";
  else verdict = "stalled";
  return {
    basis: "task_state_advance",
    verdict,
    advanced,
    idle_minutes: Math.round(idleMinutes * 10) / 10,
    idle_ok_minutes,
    is_failure: false, // 任何 verdict 都不直接等于失败；stalled 只意味着值得出卡
  };
}

// ─────────────────────────────────────────────────────────────
// §7.2 指令数据分离：事件不许自带执行参数
// ─────────────────────────────────────────────────────────────

const FORBIDDEN_EVENT_KEYS = ["cwd", "agent", "access", "tells", "prompt", "body", "text", "content"];

/**
 * 事件收不发、怎么收。
 * DESIGN §3.1 硬约束：事件里带 cwd/agent/access 一律拒收；正文只能落盘引用。
 */
export function checkEventAcceptable(event) {
  const reasons = [];
  if (!event || typeof event !== "object") return { ok: false, reasons: ["事件不是对象"] };

  for (const key of FORBIDDEN_EVENT_KEYS) {
    if (key in event) reasons.push(`事件不得自带执行参数 ${key}（只有人写的规则可以指定）`);
  }
  if (typeof event.data_ref !== "string" || !event.data_ref.startsWith("/")) {
    reasons.push("data_ref 必须是绝对文件路径：外部正文不内联、不走 http");
  }
  if (typeof event.title === "string") {
    if (/[{}]/.test(event.title)) reasons.push("title 不得含 {}：会被当模板");
    if (/^[\s-]/.test(event.title)) reasons.push("title 不得以空白或 - 开头：会被当命令行 option");
  }
  let hopsVerdict = null;
  try {
    hopsVerdict = checkHops(event);
  } catch (err) {
    reasons.push(err.message);
  }
  return {
    ok: reasons.length === 0,
    reasons,
    hops: hopsVerdict,
    dispatch: hopsVerdict ? hopsVerdict.dispatch : false,
    record_only: hopsVerdict ? hopsVerdict.record_only : true,
  };
}
