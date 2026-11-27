// protocol/test/schema.test.mjs
// 目的：证明 schema 真的在约束东西。
// 一半用例是 happy path（fixture 必须过），另一半是**故意注入违规**（必须报错，
// 而且要报在对的字段上）。只测 happy path 的 schema 等于没有 schema。

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadProtocol, loadSchemaDocs, checkHygiene, createValidator } from "../validate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const protocolDir = join(here, "..");
const fixturesDir = join(protocolDir, "fixtures");

const { docs, validate } = await loadProtocol(protocolDir);

const fixture = async (name) =>
  JSON.parse(await readFile(join(fixturesDir, `${name}.json`), "utf8"));

/** 断言 data 对 target 不合法，且至少有一条错误落在 keyword 上。 */
function assertInvalid(data, target, keyword, note) {
  const result = validate(data, target);
  assert.equal(result.valid, false, `期望不合法但通过了：${note || ""}`);
  assert.ok(
    result.errors.some((e) => e.keyword === keyword),
    `期望命中 ${keyword}，实际 ${JSON.stringify(result.errors)}（${note || ""}）`,
  );
  return result;
}

test("八个 schema 都存在、都有 $id、都能被装载", () => {
  const ids = docs.map((d) => d.schema.$id).sort();
  assert.deepEqual(ids, [
    "urn:collie:card:v1",
    "urn:collie:case:v1",
    "urn:collie:decision:v1",
    "urn:collie:event:v1",
    "urn:collie:message:v1",
    "urn:collie:receipt:v1",
    "urn:collie:ruleset:v1",
    "urn:collie:task:v1",
  ]);
});

test("卫生检查：无 TBD/TODO、无空 description、无未实现关键字", () => {
  const result = checkHygiene(docs);
  assert.deepEqual(result.problems, [], `卫生问题：\n${result.problems.join("\n")}`);
});

test("卫生检查能抓住注入的空 description / 占位词 / 未知关键字", () => {
  const bad = [
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:test:bad:v1",
      description: "故意做坏的 schema",
      type: "object",
      additionalProperties: false,
      properties: {
        hollow: { type: "string" },
        placeholder: { type: "string", description: "TODO: 以后再补" },
        weird: { type: "string", description: "用了校验器不认识的关键字", minXor: 3 },
      },
    },
  ];
  const result = checkHygiene(bad.map((schema) => ({ name: "bad.schema.json", schema })));
  assert.equal(result.ok, false);
  const joined = result.problems.join("\n");
  assert.match(joined, /hollow: 缺非空 description/);
  assert.match(joined, /含占位词 TODO/);
  assert.match(joined, /未知关键字 minXor/);
});

test("Event：fixture 合法", async () => {
  const ev = await fixture("event");
  const result = validate(ev, "urn:collie:event:v1");
  assert.deepEqual(result.errors, []);
});

test("Event：自带执行参数（cwd/agent/access）必须被拒收", async () => {
  const ev = await fixture("event");
  assertInvalid({ ...ev, cwd: "/tmp" }, "urn:collie:event:v1", "additionalProperties", "事件不能指定 cwd");
  assertInvalid({ ...ev, access: "full" }, "urn:collie:event:v1", "additionalProperties", "事件不能指定 access");
  assertInvalid({ ...ev, agent: "claude" }, "urn:collie:event:v1", "additionalProperties", "事件不能指定 agent");
});

test("Event：正文只能落盘引用，不能内联、不能走 http", async () => {
  const ev = await fixture("event");
  assertInvalid({ ...ev, data_ref: "https://gitlab.example.com/mr/93" }, "urn:collie:event:v1", "pattern", "http 正文");
  assertInvalid({ ...ev, data_ref: "relative/path.json" }, "urn:collie:event:v1", "pattern", "相对路径");
  assertInvalid({ ...ev, data_ref: "/tmp/body.json", body: "diff --git ..." }, "urn:collie:event:v1", "additionalProperties", "内联正文");
  assertInvalid({ ...ev, data_digest: "sha256:xyz" }, "urn:collie:event:v1", "pattern", "digest 形状");
});

test("Event：title 不许以 - 开头、不许含 {}（会被当命令行参数）", async () => {
  const ev = await fixture("event");
  assertInvalid({ ...ev, title: "--force" }, "urn:collie:event:v1", "pattern");
  assertInvalid({ ...ev, title: "fix {id} template" }, "urn:collie:event:v1", "pattern");
});

test("Ruleset：fixture 合法，且护栏恰好七条", async () => {
  const rs = await fixture("ruleset");
  assert.deepEqual(validate(rs, "urn:collie:ruleset:v1").errors, []);
});

test("Ruleset：删掉一条护栏 → 校验失败（护栏不可被规则削掉）", async () => {
  const rs = await fixture("ruleset");
  const minusOne = { ...rs, ask_first: rs.ask_first.filter((t) => t !== "delete_data") };
  assertInvalid(minusOne, "urn:collie:ruleset:v1", "minItems", "删掉 delete_data");
});

test("Ruleset：把某条护栏换个名字 → 校验失败（enum 是封闭的）", async () => {
  const rs = await fixture("ruleset");
  const renamed = { ...rs, ask_first: rs.ask_first.map((t) => (t === "change_permission" ? "change_role" : t)) };
  assertInvalid(renamed, "urn:collie:ruleset:v1", "enum", "自定义护栏项");
});

test("Ruleset：预算作用域与跳数上限冻结为常量", async () => {
  const rs = await fixture("ruleset");
  assertInvalid({ ...rs, budget: { ...rs.budget, scope: "per_space" } }, "urn:collie:ruleset:v1", "const", "预算按 space 算");
  assertInvalid({ ...rs, max_hops: 12 }, "urn:collie:ruleset:v1", "const", "放宽跳数");
});

test("Message：fixture 合法；人的消息不伪装成 Event", async () => {
  const message = await fixture("message");
  assert.deepEqual(validate(message, "urn:collie:message:v1").errors, []);
  assertInvalid({ ...message, source: "human", ref: "bad" }, "urn:collie:message:v1", "pattern", "human id");
  assertInvalid({ ...message, data_ref: "https://example.com/body" }, "urn:collie:message:v1", "pattern", "内联正文");
});

test("Message / Decision：对象类型不被开发场景枚举锁死", async () => {
  const message = await fixture("message");
  const genericMessage = {
    ...message, object: { kind: "calendar", id: "team-week" }, object_key: "calendar:team-week",
  };
  assert.equal(validate(genericMessage, "urn:collie:message:v1").valid, true);
  const dc = await fixture("decision");
  const genericDecision = {
    ...dc, occurrence: { ...dc.occurrence, object_key: "calendar:team-week", kind: "calendar" },
  };
  assert.equal(validate(genericDecision, "urn:collie:decision:v1").valid, true);
});

test("Case：fixture 合法；Message 来源必须是 event 或 human", async () => {
  const ca = await fixture("case");
  assert.deepEqual(validate(ca, "urn:collie:case:v1").errors, []);
  assertInvalid({ ...ca, origin: "system" }, "urn:collie:case:v1", "enum", "未知消息来源");
});

test("Case：快照不许超过 4KB、不许自己扩大视野", async () => {
  const ca = await fixture("case");
  assertInvalid(
    { ...ca, snapshot: { ...ca.snapshot, bytes: 9000 } },
    "urn:collie:case:v1",
    "maximum",
    "快照超限",
  );
  assertInvalid(
    { ...ca, scope: { ...ca.scope, forbidden_expand: false } },
    "urn:collie:case:v1",
    "const",
    "允许自己 git/gh",
  );
});

test("Decision：fixture 合法，run 只保留 canonical ref 与执行关联", async () => {
  const dc = await fixture("decision");
  assert.deepEqual(validate(dc, "urn:collie:decision:v1").errors, []);
  const longRef = { ...dc, run: { ...dc.run, task_ref: "COLL-" + "x".repeat(235) } };
  assert.deepEqual(validate(longRef, "urn:collie:decision:v1").errors, []);
  assertInvalid({ ...dc, run: { ...dc.run, task_ref: "x".repeat(241) } }, "urn:collie:decision:v1", "maxLength");
  assertInvalid({ ...dc, run: { ...dc.run, claimed_until: null } }, "urn:collie:decision:v1", "additionalProperties");
  assertInvalid({ ...dc, run: { ...dc.run, unknown_policy: "normal" } }, "urn:collie:decision:v1", "additionalProperties");
});

test("Decision：spawn 只选择执行目标与 playbook，不接受 review/merge 门禁", async () => {
  const dc = await fixture("decision");
  const action = dc.actions[0];
  assertInvalid(
    { ...dc, actions: [{ ...action, spawn: { ...action.spawn, review: true } }] },
    "urn:collie:decision:v1", "additionalProperties",
  );
  assertInvalid(
    { ...dc, actions: [{ ...action, spawn: { ...action.spawn, merge: true } }] },
    "urn:collie:decision:v1", "additionalProperties",
  );
  for (const field of ["tells", "parallel"]) {
    assertInvalid(
      { ...dc, actions: [{ ...action, spawn: { ...action.spawn, [field]: field === "tells" ? "needed" : 1 } }] },
      "urn:collie:decision:v1", "additionalProperties",
    );
  }
});

test("Decision：终态必须有 settled（ack 结不了账）", async () => {
  const dc = await fixture("decision");
  const settledNoRecord = { ...dc, state: "settled", ack: { at: "2026-11-13T10:30:00Z", by: "mi" } };
  assertInvalid(settledNoRecord, "urn:collie:decision:v1", "type", "settled 但没有 settled 记录");
});

test("Decision：run.kind 固定为 build / review / verify", async () => {
  const dc = await fixture("decision");
  for (const kind of ["build", "review", "verify"]) {
    assert.equal(validate({ ...dc, run: { ...dc.run, kind } }, "urn:collie:decision:v1").valid, true);
  }
  assertInvalid({ ...dc, run: { ...dc.run, kind: "merge" } }, "urn:collie:decision:v1", "enum");
});

test("Decision：decision_ref 引用可续接的既有 Decision", async () => {
  const dc = await fixture("decision");
  assert.equal(validate({ ...dc, decision_ref: "dc_existing01" }, "urn:collie:decision:v1").valid, true);
  assertInvalid({ ...dc, decision_ref: "TASK-1" }, "urn:collie:decision:v1", "pattern");
});

test("Decision：settled 存在时 state 必须是终态", async () => {
  const dc = await fixture("decision");
  const settledButOpen = {
    ...dc,
    settled: { at: "2026-11-13T10:30:00Z", by: "human", outcome: "accepted" },
  };
  assertInvalid(settledButOpen, "urn:collie:decision:v1", "const", "settled 与 state 不一致");
});

test("Decision：不许把机器事件注入对话", async () => {
  const dc = await fixture("decision");
  assertInvalid(
    { ...dc, human_boundary: { form: "chat", chat_injection: false } },
    "urn:collie:decision:v1",
    "enum",
    "form 只能是 card/none",
  );
  assertInvalid(
    { ...dc, human_boundary: { form: "none", chat_injection: true } },
    "urn:collie:decision:v1",
    "const",
    "chat_injection 冻结为 false",
  );
  // 也没有 chat_message 这种 action
  assertInvalid(
    { ...dc, actions: [{ kind: "chat_message", risk_tags: [] }] },
    "urn:collie:decision:v1",
    "enum",
    "action 里没有 chat_message",
  );
});

test("Decision：coordinator 不能塞护栏旁路字段", async () => {
  const dc = await fixture("decision");
  assertInvalid({ ...dc, guard_bypass: true }, "urn:collie:decision:v1", "additionalProperties");
  assertInvalid({ ...dc, risk: { tags: ["delete_data"], forced_waiting: false } }, "urn:collie:decision:v1", "const");
});

test("Decision：archived 是合法 settled outcome", async () => {
  const dc = await fixture("decision");
  const archived = {
    ...dc, state: "settled",
    settled: { at: "2026-11-13T10:30:00Z", by: "human", outcome: "archived" },
  };
  assert.equal(validate(archived, "urn:collie:decision:v1").valid, true);
});

test("Decision：waiting 必须带 card；emit_command 必须带 egress", async () => {
  const dc = await fixture("decision");
  assertInvalid({ ...dc, state: "waiting" }, "urn:collie:decision:v1", "type", "waiting 没卡");
  assertInvalid(
    { ...dc, actions: [{ kind: "emit_command", risk_tags: ["outbound_message"] }] },
    "urn:collie:decision:v1",
    "required",
    "出站动作没 payload",
  );
  assertInvalid(
    { ...dc, actions: [{ kind: "spawn_task", risk_tags: [] }] },
    "urn:collie:decision:v1",
    "required",
    "spawn 没 spawn 字段",
  );
});

test("Card：就是 Decision{state:waiting}——open 的同一对象不是卡", async () => {
  const card = await fixture("card");
  assert.deepEqual(validate(card, "urn:collie:card:v1").errors, []);
  const notWaiting = { ...card, state: "open" };
  assertInvalid(notWaiting, "urn:collie:card:v1", "const", "open 不是卡");
  // 反向：卡片形状的东西用 Decision schema 校验也必须通过（同一个对象，不是两套字段）
  assert.deepEqual(validate(card, "urn:collie:decision:v1").errors, []);
});

test("Card：rework 必须带结构化批注", async () => {
  const card = await fixture("card");
  const answered = {
    ...card,
    card: {
      ...card.card,
      state: "decided",
      answer: { option: "rework", at: "2026-11-13T10:10:00Z", by: "mi" },
    },
  };
  assertInvalid(answered, "urn:collie:card:v1", "required", "rework 没批注");
});

test("Receipt：fixture 合法；回执必须是 ready 三件套，不是最后一条消息", async () => {
  const rc = await fixture("receipt");
  assert.deepEqual(validate(rc, "urn:collie:receipt:v1").errors, []);
  assertInvalid({ ...rc, origin: "agent last message" }, "urn:collie:receipt:v1", "const", "回执来源");
  assertInvalid({ ...rc, last_message_used: false }, "urn:collie:receipt:v1", "additionalProperties", "旧 sentinel 不再属于协议");
  const noProof = { ...rc, proof: { ...rc.proof, refs: [] } };
  assertInvalid(noProof, "urn:collie:receipt:v1", "minItems", "没有凭据锚点");
  assertInvalid({ ...rc, proof: { ...rc.proof, text: rc.proof.title } }, "urn:collie:receipt:v1", "additionalProperties", "proof 不重复 title 文本");
  const noDetails = { ...rc };
  delete noDetails.details;
  assertInvalid(noDetails, "urn:collie:receipt:v1", "required", "缺 --details");
});

test("Receipt：只交付 summary/details/proof，不携带 review/verify/auto_accept 门禁", async () => {
  const rc = await fixture("receipt");
  assertInvalid({ ...rc, review: null }, "urn:collie:receipt:v1", "additionalProperties");
  assertInvalid({ ...rc, verification: { verdict: "pass", evidence: "checks" } }, "urn:collie:receipt:v1", "additionalProperties");
  assertInvalid({ ...rc, risk: { auto_accept: true } }, "urn:collie:receipt:v1", "additionalProperties");
});

test("Task：todo/running/ready/done 四态及各自必需事实", async () => {
  const ready = await fixture("task");
  const todo = {
    ...structuredClone(ready), state: "todo", started_at: null, ready_at: null,
    summary: null, details: null, proof: null, progress: null,
  };
  const running = { ...structuredClone(todo), state: "running", started_at: ready.started_at };
  const done = { ...structuredClone(ready), state: "done", done_at: ready.ready_at + 1, done_by: "human" };
  for (const task of [todo, running, ready, done]) {
    assert.deepEqual(validate(task, "urn:collie:task:v1").errors, [], task.state);
  }

  assertInvalid({ ...ready, state: "queued" }, "urn:collie:task:v1", "enum");
  for (const field of ["ready_at", "details"]) {
    const invalid = structuredClone(ready);
    delete invalid[field];
    assertInvalid(invalid, "urn:collie:task:v1", "required", `ready 缺 ${field}`);
  }
  for (const field of ["done_at", "done_by"]) {
    const invalid = structuredClone(done);
    delete invalid[field];
    assertInvalid(invalid, "urn:collie:task:v1", "required", `done 缺 ${field}`);
  }
  assertInvalid({ ...ready, state: "ready", proof: null }, "urn:collie:task:v1", "type");
  assertInvalid({ ...done, done_by: null }, "urn:collie:task:v1", "enum");
  assertInvalid({ ...ready, depends_on: ["COLL-41", "COLL-41"] }, "urn:collie:task:v1", "uniqueItems");
});

test("Receipt：判据必须是状态前进，不能是进程存活", async () => {
  const rc = await fixture("receipt");
  assertInvalid(
    { ...rc, progress: { ...rc.progress, basis: "process_alive" } },
    "urn:collie:receipt:v1",
    "const",
    "拿进程存活当判据",
  );
});

test("额外：$ref 引用不到的 schema 会被卫生检查抓出来", () => {
  const broken = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "urn:test:broken-ref:v1",
    description: "引用了一个不存在的 $id",
    allOf: [{ $ref: "urn:collie:nope:v1" }],
  };
  const result = checkHygiene([{ name: "broken.schema.json", schema: broken }]);
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /\$ref 的 \$id 不存在/);
});

test("额外：校验器不会静默忽略未实现关键字", async () => {
  const docs2 = await loadSchemaDocs(protocolDir);
  const poisoned = [
    ...docs2,
    {
      name: "poisoned.schema.json",
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "urn:test:poisoned:v1",
        description: "带一个没人实现的关键字",
        type: "string",
        description2: "x",
      },
    },
  ];
  const hygiene = checkHygiene(poisoned);
  assert.equal(hygiene.ok, false);
  // $id 重复也会被抓
  assert.throws(() => createValidator([...docs2, docs2[0]]), /\$id 重复/);
});
