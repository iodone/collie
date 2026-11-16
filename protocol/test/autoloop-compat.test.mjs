// protocol/test/autoloop-compat.test.mjs
//
// 目的：证明「照抄 agent-autoloop 会坏」的三处，确实被 schema / 不变量挡住了。
// 每个用例都用 autoloop 的假设去构造输入，断言它**被拒绝**或**被强制改写**。
// 只有 happy path 的兼容性测试等于没测——这里全是反例。

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadProtocol } from "../validate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const protocolDir = join(here, "..");

const { validate } = await loadProtocol(protocolDir);
const readJson = async (p) => JSON.parse(await readFile(join(protocolDir, p), "utf8"));

const ID = {
  receipt: "urn:collie:receipt:v1",
  decision: "urn:collie:decision:v1",
  rule: "urn:collie:rule:v1",
};

const baseReceipt = await readJson("fixtures/receipt.json");
const baseDecision = await readJson("fixtures/decision.json");
const baseRuleset = await readJson("fixtures/ruleset.json");

test("第 1 处｜autoloop：进程结束 = 失败信号 → schema 只认『状态有没有前进』", async () => {
  // 断言：判据字段被 const 冻死，改成「进程存活」直接校验失败
  const alive = structuredClone(baseReceipt);
  alive.progress.basis = "process_alive";
  const bad = validate(alive, ID.receipt);
  assert.ok(bad.errors.length > 0, "把判据改成 process_alive 必须被拒（长任务里进程活着一小时是正常的）");

  // 断言：unknown 在长任务期间是正常态，不得被当成失败策略
  const failFast = structuredClone(baseDecision);
  failFast.run.unknown_policy = "failure";
  const bad2 = validate(failFast, ID.decision);
  assert.ok(bad2.errors.length > 0, "unknown_policy 只允许 normal：unknown ≠ 失败");

  // 正向对照：原 fixture 必须通过，否则上面的拒绝可能只是别的字段错了
  assert.deepEqual(validate(structuredClone(baseReceipt), ID.receipt).errors, []);
});

test("第 2 处｜autoloop：cwd 必须是 git 仓库 → schema 允许 state 目录", async () => {
  const rule = baseRuleset.rules?.[0] ?? baseRuleset.rules[0];
  const stateCwd = structuredClone(rule);
  stateCwd.to = { ...(stateCwd.to ?? {}), cwd: { kind: "state", path: "/home/user/.local/state/collie" } };
  const res = validate(stateCwd, ID.rule);
  assert.deepEqual(res.errors, [], "kind:state 必须合法——coordinator 的活是判断，没有仓库");

  // 反向：相对路径必须被拒（状态目录也要可定位）
  const relative = structuredClone(stateCwd);
  relative.to.cwd.path = "./state";
  assert.ok(validate(relative, ID.rule).errors.length > 0, "状态目录必须是绝对路径");
});

test("第 3 处｜autoloop：回执 = 最后一条消息 → schema 只认 ready 三件套", async () => {
  const lastMessage = structuredClone(baseReceipt);
  lastMessage.last_message_used = true;
  assert.ok(validate(lastMessage, ID.receipt).errors.length > 0, "last_message_used:true 必须被拒");

  const wrongOrigin = structuredClone(baseReceipt);
  wrongOrigin.origin = "agent_final_message";
  assert.ok(validate(wrongOrigin, ID.receipt).errors.length > 0, "origin 必须是 herdr-task ready");

  // 反向：没有凭据锚点的回执也要被拒（proof.refs 至少一条）
  const noProof = structuredClone(baseReceipt);
  noProof.proof = { ...noProof.proof, refs: [] };
  assert.ok(validate(noProof, ID.receipt).errors.length > 0, "没有 evidence 指针的 ready 不算回执");
});
