import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const state = process.argv[2] ?? join(homedir(), ".local", "state", "collie");
const base = JSON.parse(readFileSync(new URL("../protocol/fixtures/decision.json", import.meta.url), "utf8"));
const receipt = JSON.parse(readFileSync(new URL("../protocol/fixtures/receipt.json", import.meta.url), "utf8"));
const queuePath = join(state, "queue.json");
let decisions = [];
try { decisions = JSON.parse(readFileSync(queuePath, "utf8")).decisions ?? []; } catch {}
const ticket = (id, state, taskRef, card = null, run = {}) => ({
  ...base, id, key: `ui:${id}`, state, why: `【UI 测试】${card?.question ?? "统一 Work 工作流"}`,
  run: { ...base.run, task_ref: taskRef, ...run },
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
const review = ticket("dc_uitest003", "waiting", "COLLIE-999", waitingCard("accept", "【UI 测试】接受这次交付吗？"));
reviewReceipt.task = { ...reviewReceipt.task, id: "COLLIE-999" };
review.receipt_ref = reviewReceipt.id;
review.ui_evidence = {
  commits: { count: 1, list: [["ef57b5e", "feat: unify ticket flow"]] },
  diff: { list: [{ path: "mods/collie/main.js", added: 86, removed: 24 }, { path: "service/main.ts", added: 31, removed: 8 }] },
  checks: { state: "passed", text: "All 131 tests passed" },
};
review.human_boundary = { form: "card", chat_injection: false };
const artifactReceipt = {
  ...reviewReceipt,
  id: "rc_uitest02",
  decision_ref: "dc_uitest009",
  summary: "【UI测试】产物页已准备好",
  details: "- Artifacts tab 显示本 folder 的 seed artifact\n- 列表来自 herdr-artifact 的真实记录",
};
artifactReceipt.task = { ...artifactReceipt.task, id: "COLLIE-999" };
const artifacts = ticket("dc_uitest009", "waiting", "COLLIE-999", waitingCard("question", "【UI测试】查看这次交付的产物吗？"));
artifacts.receipt_ref = artifactReceipt.id;
artifacts.human_boundary = { form: "card", chat_injection: false };
const fixtures = [
  // Needs you：问题、验收、失败卡
  ticket("dc_uitest001", "waiting", null, waitingCard("question", "【UI 测试】需要选择发布策略")),
  review,
  ticket("dc_uitest006", "waiting", null, { ...waitingCard("alert", "【UI 测试】任务失败了，要重试吗？"), options: ["accept", "drop", "later"] }),
  artifacts,
  // Todo：还没有 agent 在跑
  ticket("dc_uitest005", "open", null),
  // Working：build 与 review 两种 kind
  ticket("dc_uitest002", "open", "TEST-WORKING", null, { kind: "build" }),
  ticket("dc_uitest007", "open", "TEST-REVIEW", null, { kind: "review" }),
  // Settled：两种 outcome
  { ...ticket("dc_uitest004", "settled", "TEST-DONE"), settled: { at: "2026-11-16T11:00:00Z", by: "human", outcome: "accepted" } },
  { ...ticket("dc_uitest008", "settled", "TEST-DROPPED"), settled: { at: "2026-11-16T12:00:00Z", by: "human", outcome: "dropped" } },
];
// A real task list entry, so the ticket can navigate to its worktree and the Artifacts tab can
// list a seeded artifact. It lives beside the person's other task lists under ~/.herdr/tasks.
const project = resolve(new URL("..", import.meta.url).pathname);
const taskPath = join(homedir(), ".herdr", "tasks", "work-system-weaver-projects-collie.json");
let taskList = { version: 1, folder: project, kind: "repo", name: "collie",
  slug: "work-system-weaver-projects-collie", next: 1000, prefix: "COLLIE", tasks: [] };
try { taskList = { ...taskList, ...JSON.parse(readFileSync(taskPath, "utf8")) }; } catch {}
taskList.tasks = (taskList.tasks ?? []).filter((task) => task.id !== 999 && !String(task.title ?? "").includes("【UI测试】"));
taskList.tasks.push({
  id: 999, title: "【UI测试】交付凭据", prompt: "Seed ticket for the Artifacts tab.",
  state: "ready", created: Date.now(), agents: [],
  set: { review: "off", review_rounds: 0, merge: "ask", proof: "on" },
  base: "main", base_set: false, started: Date.now(),
  worktree: project, branch: "main", start: "HEAD",
  summary: "Seed artifact ready", details: "Seeded for the Artifacts tab.",
  ready_at: Date.now(), proof: { id: "seed-proof-0001", title: "Seed proof" },
});
mkdirSync(join(homedir(), ".herdr", "tasks"), { recursive: true });
writeFileSync(taskPath, JSON.stringify(taskList, null, 2), { mode: 0o600 });

// One artifact, published to this folder and attached to the seed task. Old UI seeds are removed
// first so repeating the script doesn't pile up versions.
const artifact = join(project, "mods", "collie-artifacts", "bin", "collie-artifact");
const listed = JSON.parse(execFileSync(artifact, ["list", "--folder", project, "--json"], { encoding: "utf8" }));
for (const item of listed.artifacts ?? []) {
  if (String(item.title).includes("【UI测试】")) execFileSync(artifact, ["rm", item.id, "--json"], { stdio: "ignore" });
}
const recipeDir = mkdtempSync(join(homedir(), ".config", "alma", "scratch", "collie-art-"));
try {
  mkdirSync(recipeDir, { recursive: true });
  writeFileSync(join(recipeDir, "recipe.json"), JSON.stringify({
    recipe: 1,
    blocks: [
      { type: "text", md: "Seed artifact for the Artifacts tab. It renders beside the real task artifacts." },
      { type: "table", columns: ["What", { label: "Value", align: "right" }], rows: [["Tests", "131 passed"], ["Files", "2"]] },
    ],
  }, null, 2));
  execFileSync(artifact, ["publish", recipeDir, "--title", "【UI测试】交付凭据", "--folder", project, "--task", "COLLIE-999", "--json"], { stdio: "ignore" });
} finally {
  rmSync(recipeDir, { recursive: true, force: true });
}

const withoutFixtures = decisions.filter((item) => !item.id.startsWith("dc_uitest"));
writeFileSync(queuePath, JSON.stringify({ decisions: [...withoutFixtures, ...fixtures] }, null, 2), { mode: 0o600 });
mkdirSync(join(state, "receipts"), { recursive: true });
writeFileSync(join(state, "receipts", `${reviewReceipt.id}.json`), JSON.stringify(reviewReceipt, null, 2), { mode: 0o600 });
writeFileSync(join(state, "receipts", `${artifactReceipt.id}.json`), JSON.stringify(artifactReceipt, null, 2), { mode: 0o600 });
console.log(`Seeded ${fixtures.length} UI tickets into ${queuePath}`);
