import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

const state = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : join(homedir(), ".local", "state", "collie");
const clean = process.argv.includes("--clean");
const project = resolve(new URL("..", import.meta.url).pathname);
const queuePath = join(state, "queue.json");
const metadataPath = join(state, "e2e-inbox-actions.json");
const taskIds = Array.from({ length: 4 }, (_, i) => 914 + i);
const taskPath = join(homedir(), ".local", "share", "collie", "tasks", "work-system-weaver-projects-collie.json");
const artifact = join(project, "mods", "collie-artifacts", "bin", "collie-artifact");
const collie = join(homedir(), ".local", "bin", "collie");
const E2E_PREFIX = "collie-e2e-";
const e2eName = (scenario) => `${E2E_PREFIX}${scenario.key}: ${scenario.title}`;
const isE2ETitle = (title) => String(title ?? "").startsWith(E2E_PREFIX) || String(title ?? "").startsWith("【E2E行动】");
const read = (path, fallback) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };
const isE2E = (decision) => isE2ETitle(decision?.why)
  || String(decision?.key ?? "").startsWith("human:turn:e2e-inbox-actions-");
const previous = read(metadataPath, { artifacts: [], decisionIds: [] });
try {
  const listed = JSON.parse(execFileSync(artifact, ["list", "--folder", project, "--json"], { encoding: "utf8" }));
  for (const item of listed.artifacts ?? []) {
    if (isE2ETitle(item.title)) {
      try { execFileSync(artifact, ["rm", item.id, "--json"], { stdio: "ignore" }); } catch {}
    }
  }
} catch {}
for (const id of previous.artifacts ?? []) {
  try { execFileSync(artifact, ["rm", id, "--json"], { stdio: "ignore" }); } catch {}
}
let queue = read(queuePath, { decisions: [] });
queue.decisions = (queue.decisions ?? []).filter((decision) => !isE2E(decision));
const space = queue.decisions.find((d) => typeof d?.space === "string" && d.space)?.space ?? "collie";
let taskList = read(taskPath, { version: 1, folder: project, kind: "repo", name: "collie", slug: "work-system-weaver-projects-collie", next: 1000, prefix: "COLLIE", tasks: [] });
const refs = taskIds.map((id) => `${taskList.prefix ?? "COLLIE"}-${id}`);
const oldRefs = new Set([...refs, ...(previous.taskRefs ?? [])]);
taskList.tasks = (taskList.tasks ?? []).filter((task) => !oldRefs.has(task.ref) && !isE2ETitle(task.title));
try {
  for (const file of readdirSync(join(state, "receipts"))) {
    if (/^rc_e2eact\d+(?:v\d+|_\d+)?\.json$/.test(file)) rmSync(join(state, "receipts", file), { force: true });
  }
} catch {}
mkdirSync(state, { recursive: true });
writeFileSync(queuePath, JSON.stringify(queue, null, 2), { mode: 0o600 });
mkdirSync(join(taskPath, ".."), { recursive: true });
writeFileSync(taskPath, JSON.stringify(taskList, null, 2), { mode: 0o600 });
if (clean) {
  const ledgerPath = join(state, "ledger.json");
  const ledger = read(ledgerPath, null);
  if (ledger?.version === 1 && Array.isArray(ledger.entries)) {
    const e2eDecisionIds = new Set(ledger.entries
      .filter((entry) => entry.kind === "decision" && isE2E(entry.payload))
      .map((entry) => entry.payload.id).filter(Boolean));
    const e2eCaseIds = new Set(ledger.entries
      .filter((entry) => entry.kind === "decision" && e2eDecisionIds.has(entry.payload.id))
      .map((entry) => entry.payload.case_ref).filter(Boolean));
    const removed = ledger.entries.filter((entry) =>
      (entry.kind === "decision" && e2eDecisionIds.has(entry.payload.id))
      || (entry.kind === "message" && isE2E(entry.payload))
      || (entry.kind === "case" && e2eCaseIds.has(entry.payload.id))
      || (entry.kind === "receipt" && (e2eDecisionIds.has(entry.payload.decision_ref) || String(entry.payload.id ?? "").startsWith("rc_e2eact"))));
    const removedSeq = new Set(removed.map((entry) => entry.seq));
    const entries = ledger.entries.filter((entry) => !removedSeq.has(entry.seq))
      .map((entry, index) => ({ ...entry, seq: index + 1 }));
    const backupDir = join(state, "backups");
    mkdirSync(backupDir, { recursive: true });
    const backup = join(backupDir, `ledger-before-e2e-purge-${Date.now()}.json`);
    writeFileSync(backup, JSON.stringify(ledger, null, 2), { mode: 0o600 });
    const temporary = `${ledgerPath}.e2e-cleanup.tmp`;
    writeFileSync(temporary, JSON.stringify({ ...ledger, entries }, null, 2), { mode: 0o600 });
    renameSync(temporary, ledgerPath);
    console.log(`Removed ${removed.length} E2E Ledger entries (${e2eDecisionIds.size} Decisions). Backup: ${backup}`);
  }
  rmSync(metadataPath, { force: true });
  console.log("Removed E2E inbox action tickets and their generated proofs.");
  process.exit(0);
}

const baseDecision = read(new URL("../protocol/fixtures/decision.json", import.meta.url), {});
const baseReceipt = read(new URL("../protocol/fixtures/receipt.json", import.meta.url), {});
const now = Date.now();
const iso = (offset = 0) => new Date(now + offset).toISOString();
function publish(ref, title, text) {
  const dir = mkdtempSync(join(tmpdir(), "collie-e2e-proof-"));
  try {
    writeFileSync(join(dir, "recipe.json"), JSON.stringify({ recipe: 1, blocks: [
      { type: "text", md: text },
      { type: "table", columns: ["Check", "Result"], rows: [["Receipt", "Visible"], ["Proof", "Linked"]] },
    ] }, null, 2));
    return JSON.parse(execFileSync(artifact, ["publish", dir, "--title", title, "--folder", project, "--task", ref, "--json"], { encoding: "utf8" }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function commitDecision(ref, scenario, index, receiptRef) {
  const input = {
    ...baseDecision,
    project: "collie",
    state: scenario.decisionState,
    why: e2eName(scenario),
    decided_at: iso(index * 1000),
    run: { ...baseDecision.run, task_ref: ref, kind: "build" },
    actions: [{ kind: "noop", risk_tags: [] }],
    receipt_ref: receiptRef,
    card: scenario.decisionState === "waiting" ? {
      kind: "accept", question: e2eName(scenario), options: ["accept", "rework", "archive", "later"], state: "open",
      created_at: iso(index * 1000), acked_at: null, answer: null, snooze_until: null, closed_at: null,
    } : null,
    settled: scenario.decisionState === "settled" ? { at: iso(index * 1000), by: "human", outcome: scenario.outcome } : null,
    human_boundary: { form: "card", chat_injection: false },
  };
  const result = JSON.parse(execFileSync(collie, [
    "decision", "commit", "--space", space, "--project", "collie", "--turn-id", `e2e-inbox-actions-${now}-${scenario.key}-${ref}`,
  ], { input: JSON.stringify(input), encoding: "utf8" }));
  const id = result.id ?? result.decision?.id;
  if (!id) throw new Error(`Decision commit returned no id: ${JSON.stringify(result)}`);
  return id;
}

const scenarios = [
  { key: "accept", state: "ready", decisionState: "waiting", outcome: null, receipts: 3, title: "Accept：先复核最后一次 Receipt", summary: "E2E Accept：这是最后一次 Receipt 的摘要", details: "- 应先看到 Summary 和 Details\n- 取消后仍保持 ready\n- 确认后进入 Settled", proof: true },
  { key: "archive", state: "ready", decisionState: "waiting", outcome: null, receipts: 2, title: "Archive：归档但保留交付证据", summary: "E2E Archive：归档后仍可回查 Receipt", details: "- 从行尾菜单选择 Archive\n- Task 进入 done\n- Receipt 和 Proof 不删除", proof: true },
  { key: "quote", state: "running", decisionState: "open", outcome: null, receipts: 0, title: "Quote：运行中只提供引用到 Coordinator", summary: "E2E Quote：运行中继续讨论", details: "- 行尾菜单只显示 Quote\n- 点击后聚焦 Coordinator\n- Task 状态不变", proof: false },
  { key: "settled", state: "done", decisionState: "settled", outcome: "accepted", receipts: 2, title: "Settled：从 Receipts 查看已交付 Ticket", summary: "E2E Settled：已交付 Receipt 的摘要", details: "- 从全局 Receipts 面板点击最新 Receipt\n- 直接展示 Settled Ticket 的 Receipt 详情\n- Proof refs 保持可回查", proof: true },
];
const artifacts = [];
const decisionIds = [];
for (const [index, scenario] of scenarios.entries()) {
  const id = taskIds[index], ref = refs[index];
  const count = scenario.receipts ?? 1;
  const latestReceiptId = count ? `rc_e2eact${id}v${count}` : null;
  const published = scenario.proof ? publish(ref, `${e2eName(scenario)} · Proof`, scenario.details) : null;
  if (published) artifacts.push(published.id);
  const decisionId = commitDecision(ref, scenario, index, latestReceiptId);
  decisionIds.push(decisionId);
  for (let version = 1; version <= count; version += 1) {
    const receiptId = `rc_e2eact${id}v${version}`;
    const latest = version === count;
    const receipt = {
      ...baseReceipt, id: receiptId, decision_ref: decisionId, received_at: iso(index * 1000 + version * 100),
      task: { ...baseReceipt.task, id: ref, state: scenario.state, previous_state: scenario.state === "done" ? "ready" : "running", state_changed_at: iso(index * 1000 + version * 100), started_at: iso(-60000) },
      summary: latest ? scenario.summary : `${scenario.summary}（历史 Receipt ${version}）`,
      details: latest ? scenario.details : `${scenario.details}\n- 这是第 ${version} 次 ready 的历史记录`,
      proof: published ? { id: published.id, title: published.title, refs: [`artifact:${published.id}`, "cmd:bun test test/*.test.ts"] } : { id: "unbound-proof", title: "No proof", refs: [] },
    };
    mkdirSync(join(state, "receipts"), { recursive: true });
    writeFileSync(join(state, "receipts", `${receiptId}.json`), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  }
  taskList.tasks.push({
    id, key: `${taskList.slug}#${id}`, ref, title: e2eName(scenario), prompt: scenario.details,
    state: scenario.state, created_at: now - 60000, started_at: now - 50000, ready_at: scenario.state === "running" ? null : now - 40000,
    done_at: scenario.state === "done" ? now - 30000 : null, done_by: scenario.state === "done" ? "human" : null,
    agents: [], depends_on: [], worktree: project, branch: "main", start: "HEAD", base: "main", base_set: false,
    summary: scenario.state === "running" ? null : scenario.summary, details: scenario.state === "running" ? null : scenario.details,
    proof: published ? { id: published.id, title: published.title } : null,
    progress: scenario.state === "running" ? { text: "Running for Quote E2E", at: now, set: now, done: 45 } : null,
  });
}
queue = read(queuePath, { decisions: [] });
queue.decisions = (queue.decisions ?? []).filter((decision) => !isE2E(decision) || decisionIds.includes(decision.id));
writeFileSync(queuePath, JSON.stringify(queue, null, 2), { mode: 0o600 });
writeFileSync(taskPath, JSON.stringify(taskList, null, 2), { mode: 0o600 });
writeFileSync(metadataPath, JSON.stringify({ decisionIds, taskRefs: refs, artifacts }, null, 2), { mode: 0o600 });
console.log(`Seeded ${scenarios.length} E2E inbox action tickets through Collie's real service into ${queuePath}`);
for (const [index, scenario] of scenarios.entries()) console.log(`${refs[index]}  ${decisionIds[index]}  ${e2eName(scenario)}`);
console.log("Clean up with: node test/e2e-inbox-actions.mjs --clean");
