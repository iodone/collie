// protocol/test/invariants.test.mjs
// DESIGN §7 的每条不变量，一条一组用例。
// 每个用例要么证明「合法时放行」，要么证明「违规时被拦住」——后者才是重点。

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  answerCard,
  applyGuard,
  assertAckSettledDistinct,
  assertRulesetGuard,
  checkBudget,
  checkEventAcceptable,
  checkHops,
  checkPriorityChange,
  isAcked,
  isSettled,
  judgeProgress,
  markAcked,
  nextHops,
  priorityChanges,
  settle,
  usedBudget,
} from "../invariants.mjs";
import * as invariants from "../invariants.mjs";
import {
  ASK_FIRST,
  BUDGET_PER_HOUR,
  MAX_HOPS,
  PRIORITY_MAX_CHANGES_PER_24H,
  SNAPSHOT_BYTES_MAX,
} from "../constants.mjs";
import { loadProtocol } from "../validate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const protocolDir = join(here, "..");
const fixturesDir = join(protocolDir, "fixtures");
const fixture = async (name) => JSON.parse(await readFile(join(fixturesDir, `${name}.json`), "utf8"));

const { validate } = await loadProtocol(protocolDir);

const NOW = "2026-11-13T12:00:00Z";

const minutesAgo = (n) => new Date(Date.parse(NOW) - n * 60000).toISOString();
const hoursAgo = (n) => new Date(Date.parse(NOW) - n * 3600000).toISOString();

// ── §7.3 跳数熔断 ─────────────────────────────────────────────

test("hops ≤ 8：8 跳还能派，9 跳只记录并出卡", () => {
  assert.equal(MAX_HOPS, 8);
  const ok = checkHops({ hops: 8 });
  assert.equal(ok.dispatch, true);
  assert.equal(ok.record_only, false);

  const deep = checkHops({ hops: MAX_HOPS + 1 });
  assert.equal(deep.dispatch, false);
  assert.equal(deep.record_only, true);
  assert.equal(deep.card_required, true);
  assert.match(deep.reason, /只记录并出卡/);

  // 不是拒收：>8 的事件仍然可记录（DESIGN §7.3「只记录」），只是不许派发
  assert.equal(checkHops({ hops: 12 }).record_only, true);
});

test("hops 必须是非负整数：负数 / 小数 / 字符串都拦", () => {
  assert.throws(() => checkHops({ hops: -1 }), /非负整数/);
  assert.throws(() => checkHops({ hops: 1.5 }), /非负整数/);
  assert.throws(() => checkHops({ hops: "3" }), /非负整数/);
});

test("派发新任务 = hops + 1；到 9 就不许 spawn", () => {
  const d = { occurrence: { hops: 7 } };
  const step = nextHops(d);
  assert.equal(step.hops, 8);
  assert.equal(step.dispatch, true);
  assert.equal(step.decision.occurrence.hops, 8);

  const tooDeep = nextHops({ occurrence: { hops: 8 } });
  assert.equal(tooDeep.hops, 9);
  assert.equal(tooDeep.dispatch, false);
  assert.equal(tooDeep.card_required, true);
});

test("卡片回答不清零 hops：6 跳卡答完还是 6 跳", async () => {
  const card = await fixture("card");
  const withHops = { ...card, occurrence: { ...card.occurrence, hops: 6 } };
  const answered = answerCard(withHops, { option: "accept", at: NOW, by: "mi" });
  assert.equal(answered.occurrence.hops, 6);
  assert.equal(answered.state, "routed");
});

test("卡片回答也不能「顺手」减少或放大 hops（9 跳答完还是 9 跳，下一次仍只记录）", async () => {
  const card = await fixture("card");
  const deep = { ...card, occurrence: { ...card.occurrence, hops: 9 } };
  const answered = answerCard(deep, { option: "accept", at: NOW, by: "mi" });
  assert.equal(answered.occurrence.hops, 9);
  assert.equal(checkHops({ hops: answered.occurrence.hops }).dispatch, false);
});

test("卡片回答的合法性：rework 必须带批注，drop 才落 settled", async () => {
  const card = await fixture("card");
  assert.throws(() => answerCard(card, { option: "rework", at: NOW, by: "mi" }), /批注/);
  const reworked = answerCard(card, {
    option: "rework",
    at: NOW,
    by: "mi",
    annotations: [{ file: "protocol/invariants.mjs", line: 88, note: "这里不能吞掉 stalled 判定" }],
  });
  assert.equal(reworked.card.answer.annotations.length, 1);
  assert.equal(reworked.settled, null);
  assert.equal(reworked.state, "routed");

  const dropped = answerCard(card, { option: "drop", at: NOW, by: "mi" });
  assert.equal(dropped.state, "closed");
  assert.equal(dropped.settled.outcome, "dropped");

  const later = answerCard(card, { option: "later", at: NOW, by: "mi", snooze_until: minutesAgo(-120) });
  assert.equal(later.state, "waiting");
  assert.equal(later.occurrence.hops, card.occurrence.hops);

  assert.throws(() => answerCard(card, { option: "maybe", at: NOW, by: "mi" }), /非法选项/);
  assert.throws(() => answerCard({ ...card, state: "routed" }, { option: "accept", at: NOW, by: "mi" }), /只有 waiting/);
});

// ── 每小时唤醒预算：全局一份 ─────────────────────────────────

const wakeCase = (createdAt, space = "collie", stream = "job_turn") => ({
  created_at: createdAt,
  space: { primary: space },
  stream,
  wake: stream === "job_turn",
});

test("全局预算默认 6/小时：第 7 次唤醒被拦，降级为卡", () => {
  assert.equal(BUDGET_PER_HOUR, 6);
  const cases = Array.from({ length: 6 }, (_, i) => wakeCase(minutesAgo(50 - i * 5)));
  const before = checkBudget(cases, NOW);
  assert.equal(before.used, 6);
  assert.equal(before.allowed, false);
  assert.equal(before.remaining, 0);
  assert.equal(before.degrade_to_card, true);
  assert.equal(before.scope, "global");

  const five = checkBudget(cases.slice(0, 5), NOW);
  assert.equal(five.allowed, true);
  assert.equal(five.remaining, 1);
});

test("预算按全局算，不按 space 算：三个 space 各 2 次就已经用完", () => {
  const cases = [
    wakeCase(minutesAgo(40), "collie"),
    wakeCase(minutesAgo(38), "collie"),
    wakeCase(minutesAgo(30), "blog"),
    wakeCase(minutesAgo(28), "blog"),
    wakeCase(minutesAgo(20), "slide"),
    wakeCase(minutesAgo(18), "slide"),
  ];
  const budget = checkBudget(cases, NOW);
  assert.equal(budget.used, 6);
  assert.equal(budget.allowed, false, "若按 space 算，这里每 space 只用了 2 次，会误判为放行");
});

test("chat turn 不吃预算（人自己说话不该消耗自己的唤醒额度）", () => {
  const humans = Array.from({ length: 10 }, (_, i) => wakeCase(minutesAgo(30 - i), "collie", "chat_turn"));
  const budget = checkBudget(humans, NOW);
  assert.equal(budget.used, 0);
  assert.equal(budget.allowed, true);
  assert.equal(usedBudget(humans, NOW).length, 0);
});

test("窗口滑动：61 分钟前的唤醒不计入", () => {
  const cases = [wakeCase(minutesAgo(61)), wakeCase(minutesAgo(59))];
  assert.equal(usedBudget(cases, NOW).length, 1);
  const budget = checkBudget(cases, NOW);
  assert.equal(budget.used, 1);
  assert.ok(Date.parse(budget.reset_at) > Date.parse(NOW) - 61 * 60000);
});

// ── priority：24h 内最多改 2 次，第 3 次必须出卡 ──────────────

const priorityDecision = (objectKey, decidedAt) => ({
  id: "dc_01h9z3k7m2n4p6qz",
  decided_at: decidedAt,
  occurrence: { object_key: objectKey, hops: 0, round: 1 },
  actions: [{ kind: "priority", risk_tags: [], priority: { target_task: "t-1", value: 3 } }],
});

test("priority 变更第 1、2 次放行，第 3 次必须出卡", () => {
  assert.equal(PRIORITY_MAX_CHANGES_PER_24H, 2);
  const one = priorityDecision("mr:mr!93", hoursAgo(3));
  const two = priorityDecision("mr:mr!93", hoursAgo(2));

  const first = checkPriorityChange([], priorityDecision("mr:mr!93", NOW), NOW);
  assert.equal(first.allowed, true);
  assert.equal(first.requires_card, false);

  const second = checkPriorityChange([one], priorityDecision("mr:mr!93", NOW), NOW);
  assert.equal(second.allowed, true);
  assert.equal(second.changes_in_window, 1);

  const third = checkPriorityChange([one, two], priorityDecision("mr:mr!93", NOW), NOW);
  assert.equal(third.requires_card, true);
  assert.equal(third.allowed, false);
  assert.equal(third.changes_in_window, 2);
  assert.match(third.reason, /必须出卡/);

  // 人从卡片上选的，可以越过次数限制——护栏是「叫人看一眼」，不是「禁止改」
  const viaCard = checkPriorityChange([one, two], priorityDecision("mr:mr!93", NOW), NOW, { via_card: true });
  assert.equal(viaCard.allowed, true);
  assert.equal(viaCard.requires_card, true);
});

test("priority 窗口按 object 计：别的对象、24h 外都不算", () => {
  const other = priorityDecision("issue:issue#41", hoursAgo(1));
  const old = priorityDecision("mr:mr!93", hoursAgo(25));
  const same = priorityDecision("mr:mr!93", hoursAgo(1));
  const history = [other, old, same];
  const result = checkPriorityChange(history, priorityDecision("mr:mr!93", NOW), NOW);
  assert.equal(result.changes_in_window, 1);
  assert.equal(result.allowed, true);
  assert.equal(priorityChanges(history, "mr:mr!93", NOW).length, 1);
});

// ── 护栏七条：规则与 coordinator 都绕不过 ────────────────────

test("askFirst 恰好七条，且断言器拒绝任何删改", async () => {
  assert.deepEqual(ASK_FIRST, [
    "delete_data",
    "stop_service",
    "spend_money",
    "outbound_message",
    "product_direction",
    "rotate_secret",
    "change_permission",
  ]);
  const rs = await fixture("ruleset");
  assert.equal(assertRulesetGuard(rs), true);

  assert.throws(() => assertRulesetGuard({ ask_first: ASK_FIRST.slice(1) }), /不可删减/);
  assert.throws(
    () => assertRulesetGuard({ ask_first: [...ASK_FIRST.slice(0, 6), "change_role"] }),
    /不可被规则削掉/,
  );
  assert.throws(() => assertRulesetGuard({ ask_first: [...ASK_FIRST, "anything_else"] }), /恰好 7 条/);
  assert.throws(() => assertRulesetGuard({ ask_first: [...ASK_FIRST.slice(0, 6), "delete_data"] }), /重复/);
  assert.throws(() => assertRulesetGuard({}), /缺 ask_first/);
});

test("命中任一条护栏都必须落到 waiting + approval 卡，规则说 never 也没用", async () => {
  const rs = await fixture("ruleset");
  const dc = await fixture("decision");

  for (const tag of ASK_FIRST) {
    const decided = {
      ...dc,
      state: "routed",
      decided_by: "rule_table",
      risk: { tags: [], forced_waiting: false },
      actions: [
        {
          kind: "spawn_task",
          risk_tags: [tag],
          spawn: {
            title: "cleanup",
            brief_ref: "/tmp/brief.md",
            base: "main",
            review: true,
            merge: true,
            access: "full",
            tells: "never",
          },
        },
      ],
    };
    const result = applyGuard(decided, rs);
    assert.equal(result.forced_waiting, true, `${tag} 没被拦住`);
    assert.equal(result.decision.state, "waiting");
    assert.equal(result.decision.card.kind, "approval");
    assert.equal(result.decision.human_boundary.form, "card");
    assert.ok(result.decision.risk.tags.includes(tag));
    assert.deepEqual(validate(result.decision, "urn:collie:decision:v1").errors, []);
  }
});

test("coordinator 自称「没风险」不算：判据只看动作干了什么", async () => {
  const rs = await fixture("ruleset");
  const dc = await fixture("decision");
  const lying = {
    ...dc,
    state: "routed",
    risk: { tags: [], forced_waiting: false }, // 自填为空
    actions: [{ kind: "emit_command", risk_tags: ["delete_data"], egress: { target: "gitlab", op: "comment", payload_ref: "/tmp/p.md" } }],
  };
  const result = applyGuard(lying, rs);
  assert.equal(result.forced_waiting, true);
  assert.deepEqual(result.decision.risk.tags.sort(), ["delete_data", "outbound_message"]);
});

test("对外发消息即使没在 risk_tags 里写，也由 egress.op 推出来", async () => {
  const rs = await fixture("ruleset");
  const dc = await fixture("decision");
  const sneaky = {
    ...dc,
    risk_tags: [],
    actions: [{ kind: "emit_command", risk_tags: [], egress: { target: "im", op: "notify", payload_ref: "/tmp/n.md" } }],
  };
  const result = applyGuard(sneaky, rs);
  assert.equal(result.forced_waiting, true);
  assert.deepEqual(result.decision.risk.tags, ["outbound_message"]);
});

test("护栏不可绕过的结构性一层：schema 不接受 guard 旁路字段", async () => {
  const dc = await fixture("decision");
  const bypass = {
    ...dc,
    guard_bypass: true,
    actions: [
      {
        kind: "spawn_task",
        risk_tags: ["delete_data"],
        spawn: {
          title: "rm -rf",
          brief_ref: "/tmp/b.md",
          base: "main",
          review: false,
          merge: true,
          access: "full",
          tells: "never",
        },
      },
    ],
  };
  const result = validate(bypass, "urn:collie:decision:v1");
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.keyword === "additionalProperties"));
});

test("无护栏命中时 applyGuard 不改判，但会重写 risk 并可用权威 hops 覆盖自填值", async () => {
  const rs = await fixture("ruleset");
  const dc = await fixture("decision");
  const withFakeHops = { ...dc, occurrence: { ...dc.occurrence, hops: 0 } };
  const result = applyGuard(withFakeHops, rs, { authoritative: { hops: 5 } });
  assert.equal(result.forced_waiting, false);
  assert.equal(result.decision.state, "routed");
  assert.equal(result.decision.occurrence.hops, 5, "coordinator 自填的 hops 必须被权威值覆盖");
  assert.equal(result.decision.card, null);
});

test("事件不能进人的对话：applyGuard 拒收声明 chat_injection 的决定", async () => {
  const rs = await fixture("ruleset");
  const dc = await fixture("decision");
  assert.throws(
    () => applyGuard({ ...dc, human_boundary: { form: "none", chat_injection: true } }, rs),
    /不能进人的对话/,
  );
});

// ── ack ≠ settled ────────────────────────────────────────────

test("ack 与 settled 是两个字段：ack 不改状态、不结账", async () => {
  const dc = await fixture("decision");
  const acked = markAcked(dc, { at: NOW, by: "mi" });

  assert.equal(isAcked(acked), true);
  assert.equal(isSettled(acked), false);
  assert.equal(acked.state, dc.state, "ack 不得改变 state");
  assert.equal(acked.settled, null, "ack 不得产生 settled");

  const settled = settle(acked, { at: NOW, by: "human", outcome: "merged" });
  assert.equal(isSettled(settled), true);
  assert.equal(settled.state, "done");
  assert.equal(settled.settled.outcome, "merged");
  assert.deepEqual(assertAckSettledDistinct(settled), { acked: true, settled: true });
});

test("settled 不能被 ack 推导：没有 outcome 就结不了账", async () => {
  const dc = await fixture("decision");
  assert.throws(() => settle(dc, { at: NOW, by: "human" }), /outcome/);
  assert.throws(() => settle(dc, { at: NOW, by: "robot", outcome: "accepted" }), /by/);
  // 只有 ack 的决定，isSettled 必须是 false，且不抛
  assert.equal(isSettled(markAcked(dc, { at: NOW, by: "mi" })), false);
  // 没有 markAcked/settledFromAck 这种「ack 即结账」的入口
  assert.equal("settledFromAck" in invariants, false);
  assert.equal("ackToSettled" in invariants, false);
});

test("settled 写了但 state 不是终态 → 直接报错（两份真相比没有真相更糟）", async () => {
  const dc = await fixture("decision");
  const inconsistent = { ...dc, settled: { at: NOW, by: "human", outcome: "accepted" } };
  assert.throws(() => isSettled(inconsistent), /不是终态/);
});

test("卡片 acked_at 与 answer 分离：ack 过但没答的卡仍是 open", async () => {
  const card = await fixture("card");
  const acked = { ...card, card: { ...card.card, acked_at: NOW } };
  assert.equal(acked.card.state, "open");
  assert.equal(acked.card.answer, null);
  assert.equal(isAcked(acked), false, "卡片的 acked_at 不等于 Decision.ack");
  assert.equal(isSettled(acked), false);
});

// ── 照抄 autoloop 会坏的第 1 处：unknown 是正常态 ────────────

test("长任务没进展 ≠ 失败：状态没前进且未超阈值时判 idle_normal，且 is_failure 恒 false", async () => {
  const rc = await fixture("receipt");
  const calm = {
    ...rc,
    task: { ...rc.task, previous_state: "working", state_changed_at: minutesAgo(45) },
    progress: { basis: "task_state_advance", advanced: false, verdict: "idle_normal" },
  };
  const verdict = judgeProgress(calm, NOW);
  assert.equal(verdict.verdict, "idle_normal");
  assert.equal(verdict.basis, "task_state_advance");
  assert.equal(verdict.is_failure, false);

  const advanced = judgeProgress(rc, NOW);
  assert.equal(advanced.verdict, "advanced");
  assert.equal(advanced.is_failure, false);

  const stuck = judgeProgress(
    { ...calm, task: { ...calm.task, state_changed_at: minutesAgo(200) } },
    NOW,
  );
  assert.equal(stuck.verdict, "stalled");
  assert.equal(stuck.is_failure, false, "stalled 只意味着该出卡，不等于失败");

  // 判据字段在 schema 里被冻结：改成 process_alive 直接不合法
  const bad = { ...rc, progress: { basis: "process_alive", advanced: true, verdict: "advanced" } };
  assert.equal(validate(bad, "urn:collie:receipt:v1").valid, false);
});

// ── 照抄 autoloop 会坏的第 2 / 3 处的调用侧约束 ──────────────

test("coordinator 的 cwd 可以是非 git 状态目录，且快照上限是常量 4KB", async () => {
  const rs = await fixture("ruleset");
  assert.equal(rs.rules[0].to.cwd.kind, "state");
  assert.equal(SNAPSHOT_BYTES_MAX, 4096);
  assert.deepEqual(validate(rs.rules[0], "urn:collie:rule:v1").errors, []);
});

test("回执是 ready 三件套，不是最后一条消息", async () => {
  const rc = await fixture("receipt");
  assert.equal(rc.origin, "herdr-task ready");
  assert.equal(rc.last_message_used, false);
  assert.ok(rc.proof.refs.length >= 1);
  assert.equal(validate(rc, "urn:collie:receipt:v1").valid, true);
  assert.equal(validate({ ...rc, last_message_used: true }, "urn:collie:receipt:v1").valid, false);
});

// ── §7.2 指令数据分离 ───────────────────────────────────────

test("事件自带执行参数一律拒收；正文必须是落盘的绝对路径", async () => {
  const ev = await fixture("event");
  const ok = checkEventAcceptable(ev);
  assert.equal(ok.ok, true);
  assert.equal(ok.dispatch, true);

  const withCwd = checkEventAcceptable({ ...ev, cwd: "/tmp" });
  assert.equal(withCwd.ok, false);
  assert.match(withCwd.reasons.join("\n"), /cwd/);

  const httpBody = checkEventAcceptable({ ...ev, data_ref: "https://example.com/mr.diff" });
  assert.equal(httpBody.ok, false);
  assert.match(httpBody.reasons.join("\n"), /绝对文件路径/);

  const deep = checkEventAcceptable({ ...ev, hops: 9 });
  assert.equal(deep.record_only, true);
  assert.equal(deep.dispatch, false);
  // 只记录不等于拒收：ok 仍为 true（证据要留下）
  assert.equal(deep.ok, true);
});
