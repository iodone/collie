import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const state = process.argv[2] ?? join(homedir(), ".local", "state", "collie");
const base = JSON.parse(readFileSync(new URL("../protocol/fixtures/decision.json", import.meta.url), "utf8"));
const receipt = JSON.parse(readFileSync(new URL("../protocol/fixtures/receipt.json", import.meta.url), "utf8"));
const queuePath = join(state, "queue.json");
let decisions = [];
try { decisions = JSON.parse(readFileSync(queuePath, "utf8")).decisions ?? []; } catch {}
const ticket = (id, state, taskRef, card = null) => ({
  ...base, id, key: `ui:${id}`, state, why: `【UI 测试】${card?.question ?? "统一 Ticket 工作流"}`,
  run: { ...base.run, task_ref: taskRef },
  card,
});
const waitingCard = (kind, question) => ({
  kind, question, options: ["accept", "rework", "drop", "later"], state: "open",
  created_at: "2026-11-16T10:00:00Z", acked_at: null, answer: null, snooze_until: null, closed_at: null,
});
const reviewReceipt = {
  ...receipt,
  id: "rc_uitest01",
  decision_ref: "dc_uitest003",
  summary: "【UI 测试】双循环 Ticket 详情已准备好",
  details: "- 统一 Decision 与 Task 视图\n- 展示变更、检查和 Proof\n- 在 Inbox 内完成 Review",
  proof: {
    refs: ["commit:ef57b5e", "cmd:npm test (131 passed)", "mods/collie/main.js:250"],
    text: "131 tests passed\nTicket detail evidence rendered",
  },
};
const review = ticket("dc_uitest003", "waiting", "TEST-REVIEW", waitingCard("accept", "【UI 测试】接受这次交付吗？"));
review.receipt_ref = reviewReceipt.id;
review.ui_evidence = {
  commits: { count: 1, list: [["ef57b5e", "feat: unify ticket flow"]] },
  diff: { list: [{ path: "mods/collie/main.js", added: 86, removed: 24 }, { path: "service/main.ts", added: 31, removed: 8 }] },
  checks: { state: "passed", text: "All 131 tests passed" },
};
review.human_boundary = { form: "card", chat_injection: false };
const fixtures = [
  ticket("dc_uitest001", "waiting", null, waitingCard("question", "【UI 测试】需要选择发布策略")),
  ticket("dc_uitest002", "acting", "TEST-WORKING"),
  review,
  { ...ticket("dc_uitest004", "done", "TEST-DONE"), settled: { at: "2026-11-16T11:00:00Z", by: "human", outcome: "accepted" } },
];
const withoutFixtures = decisions.filter((item) => !item.id.startsWith("dc_uitest"));
writeFileSync(queuePath, JSON.stringify({ decisions: [...withoutFixtures, ...fixtures] }, null, 2), { mode: 0o600 });
mkdirSync(join(state, "receipts"), { recursive: true });
writeFileSync(join(state, "receipts", `${reviewReceipt.id}.json`), JSON.stringify(reviewReceipt, null, 2), { mode: 0o600 });
console.log(`Seeded ${fixtures.length} UI tickets into ${queuePath}`);
