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

test("六个 schema 都存在、都有 $id、都能被装载", () => {
  const ids = docs.map((d) => d.schema.$id).sort();
  assert.deepEqual(ids, [
    "urn:collie:card:v1",
    "urn:collie:case:v1",
    "urn:collie:decision:v1",
    "urn:collie:event:v1",
    "urn:collie:receipt:v1",
    "urn:collie:ruleset:v1",
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

test("Case：fixture 合法；job_turn 不得出现在 chat 里", async () => {
  const ca = await fixture("case");
  assert.deepEqual(validate(ca, "urn:collie:case:v1").errors, []);
  assertInvalid({ ...ca, visibility: "chat" }, "urn:collie:case:v1", "const", "机器事件进对话");
  assertInvalid({ ...ca, wake: false }, "urn:collie:case:v1", "const", "job_turn 必须计预算");
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

test("Decision：fixture 合法", async () => {
  const dc = await fixture("decision");
  assert.deepEqual(validate(dc, "urn:collie:decision:v1").errors, []);
});

test("Decision：终态必须有 settled（ack 结不了账）", async () => {
  const dc = await fixture("decision");
  const settledNoRecord = { ...dc, state: "settled", ack: { at: "2026-11-13T10:30:00Z", by: "mi" } };
  assertInvalid(settledNoRecord, "urn:collie:decision:v1", "type", "settled 但没有 settled 记录");
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
  assertInvalid({ ...rc, last_message_used: true }, "urn:collie:receipt:v1", "const", "拿最后一条消息当回执");
  assertInvalid({ ...rc, origin: "agent last message" }, "urn:collie:receipt:v1", "const", "回执来源");
  const noProof = { ...rc, proof: { refs: [], text: "看提交吧" } };
  assertInvalid(noProof, "urn:collie:receipt:v1", "minItems", "没有凭据锚点");
  const noDetails = { ...rc };
  delete noDetails.details;
  assertInvalid(noDetails, "urn:collie:receipt:v1", "required", "缺 --details");
});

test("Receipt：没复核不许 ready；护栏命中不许 auto_accept", async () => {
  const rc = await fixture("receipt");
  assertInvalid(
    { ...rc, review: { ...rc.review, reviewed: false } },
    "urn:collie:receipt:v1",
    "const",
    "没复核就 ready",
  );
  assertInvalid(
    { ...rc, risk: { tags: ["delete_data"], level: "high", auto_accept: true } },
    "urn:collie:receipt:v1",
    "const",
    "护栏命中还自动接受",
  );
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
