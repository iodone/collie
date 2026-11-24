import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { CollieService } from "../service/main.ts";
import { startAnswerServer } from "../service/answer-server.ts";

const ruleset = await Bun.file(new URL("../protocol/fixtures/ruleset.json", import.meta.url)).json();
const receiptFixture = await Bun.file(new URL("../protocol/fixtures/receipt.json", import.meta.url)).json();
const root = new URL("..", import.meta.url).pathname;
const python = Bun.which("python3") ?? "python3";
const paths: string[] = [];
const servers: ReturnType<typeof startAnswerServer>[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.close();
  while (paths.length) rmSync(paths.pop()!, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "collie-ticket-"));
  paths.push(dir);
  return dir;
}

function fakeAgent() {
  const calls: string[][] = [];
  return { calls, run: async (args: string[]) => {
    if (args[0] !== "list") calls.push(args);
    if (args[0] === "add") return { id: 42, ref: "HAT-42" };
    if (args[0] === "start") return { id: 42, state: "running" };
    if (args[0] === "list") return [];
    return {
      id: 42, key: "HAT-42", state: "ready", started_at: 1_763_664_030_000, ready_at: 1_763_666_480_000,
      evidence: { summary: "ticket 完成", details: "- 已复核", commits: { list: [["abc1234", "ticket"]] }, proof: { id: "proof-1", title: "tests passed" } },
    };
  } };
}

async function serve(service: CollieService, dir: string): Promise<string> {
  const socket = join(dir, "service.sock");
  const server = startAnswerServer(service, socket);
  servers.push(server);
  const { promise, resolve } = Promise.withResolvers<void>();
  if (server.listening) resolve();
  else server.once("listening", () => resolve());
  await promise;
  return socket;
}

type Json = Record<string, unknown>;

function post(socketPath: string, path: string, body: unknown): Promise<{ status: number; body: Json }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: Json }>();
  const req = request({ socketPath, path, method: "POST" }, (res) => {
    let text = "";
    res.on("data", (chunk) => { text += chunk; });
    res.on("end", () => {
      const parsed: unknown = JSON.parse(text);
      resolve({ status: res.statusCode ?? 0, body: parsed as Json });
    });
  });
  req.on("error", reject);
  req.end(JSON.stringify(body));
  return promise;
}

describe("collie ticket create", () => {
  test("POST /ticket writes one open spawn Decision, projects the queue and spawns once", async () => {
    const dir = scratch();
    const agent = fakeAgent();
    const service = new CollieService({
      stateDir: dir, ruleset, agent: { run: agent.run },
      workspaces: { collie: { folder: "/repo/collie" } },
    });
    const socket = await serve(service, dir);
    const brief = "# 实现 collie ticket\n\n只走工具，不在 chat 里伪造状态。";

    const response = await post(socket, "/ticket", {
      space: "collie", title: "实现 collie ticket", brief, kind: "review",
    });

    expect(response.status).toBe(200);
    expect(response.body.decision_id).toMatch(/^dc_[0-9a-z]{8,32}$/);
    expect(response.body.ticket_ref).toBe("HAT-42");
    expect(agent.calls.map((call) => call[0])).toEqual(["add", "start", "show"]);

    const created = service.ledger.history("decision").find((decision) =>
      decision.id === response.body.decision_id && decision.actions.some((action: Json) => action.kind === "spawn_task"),
    );
    expect(created.state).toBe("open");
    expect(created.origin).toBe("human");
    expect(created.playbook).toEqual({ name: "review", version: service.collaboration.playbook("review").version });
    expect(created.run.kind).toBe("review");
    expect(created.actions).toHaveLength(1);
    expect(created.actions[0].spawn).toMatchObject({
      title: "实现 collie ticket", base: "current", access: "read",
    });
    expect(readFileSync(created.actions[0].spawn.brief_ref, "utf8")).toContain("human.ticket_requested");

    const tickets = readdirSync(join(dir, "tickets"));
    expect(tickets).toHaveLength(1);
    expect(readFileSync(join(dir, "tickets", tickets[0]), "utf8")).toBe(brief);

    const queue = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    expect(queue.decisions).toHaveLength(1);
    expect(queue.decisions[0].id).toBe(response.body.decision_id);
    expect(queue.decisions[0].run.task_ref).toBe("HAT-42");
    expect(queue.decisions[0].state).toBe("waiting");
  });

  test("invalid space, title, brief and kind are rejected without spawning", async () => {
    const dir = scratch();
    const agent = fakeAgent();
    const service = new CollieService({
      stateDir: dir, ruleset, agent: { run: agent.run },
      workspaces: { collie: { folder: "/repo/collie" } },
    });
    const socket = await serve(service, dir);

    const payloads = [
      { space: "Collie!", title: "ok", brief: "body" },
      { space: "collie", title: "-oops", brief: "body" },
      { space: "collie", title: "has {placeholder}", brief: "body" },
      { space: "collie", title: "", brief: "body" },
      { space: "collie", title: "ok", brief: "   " },
      { space: "collie", title: "ok", brief: "body", kind: "merge" },
    ];
    for (const payload of payloads) {
      const response = await post(socket, "/ticket", payload);
      expect(response.status).toBe(400);
      expect(typeof response.body.error).toBe("string");
    }
    expect(agent.calls).toEqual([]);
    expect(service.ledger.decisions).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"))).toEqual({ decisions: [] });
  });

  test("collie ticket CLI accepts an inline brief, not only a file path", async () => {
    const dir = scratch();
    const agent = fakeAgent();
    const service = new CollieService({
      stateDir: dir, ruleset, agent: { run: agent.run },
      workspaces: { collie: { folder: "/repo/collie" } },
    });
    await serve(service, dir);
    const child = Bun.spawn([
      python, join(root, "bin", "collie"), "ticket", "create",
      "--state-dir", dir, "--space", "collie", "--title", "inline ticket",
      "--brief", "inline body", "--kind", "build",
    ], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect([code, stderr]).toEqual([0, ""]);
    expect(JSON.parse(stdout)).toEqual({ decision_id: expect.stringMatching(/^dc_/), ticket_ref: "HAT-42" });
  });

  test("collie ticket CLI posts the brief file and prints {decision_id,ticket_ref}", async () => {
    const dir = scratch();
    const agent = fakeAgent();
    const service = new CollieService({
      stateDir: dir, ruleset, agent: { run: agent.run },
      workspaces: { collie: { folder: "/repo/collie" } },
    });
    await serve(service, dir);
    const briefPath = join(dir, "brief.md");
    writeFileSync(briefPath, "# CLI brief\n");

    const child = Bun.spawn([
      python, join(root, "bin", "collie"), "ticket", "create",
      "--state-dir", dir, "--space", "collie", "--title", "CLI ticket",
      "--brief", briefPath, "--kind", "build",
    ], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);

    expect([code, stderr]).toEqual([0, ""]);
    const result = JSON.parse(stdout);
    expect(result).toEqual({ decision_id: expect.stringMatching(/^dc_/), ticket_ref: "HAT-42" });
    expect(agent.calls.map((call) => call[0])).toEqual(["add", "start", "show"]);

    const shown = Bun.spawn([
      python, join(root, "bin", "collie"), "ticket", "show",
      "--state-dir", dir, "--decision", result.decision_id,
    ], { stdout: "pipe", stderr: "pipe" });
    const [shownOut, shownCode] = await Promise.all([new Response(shown.stdout).text(), shown.exited]);
    expect(shownCode).toBe(0);
    expect(JSON.parse(shownOut)).toMatchObject({
      decision_id: result.decision_id, ticket_ref: "HAT-42", kind: "build", state: "waiting",
    });
  });
});

describe("collie ticket adopt", () => {
  test("POST /ticket/adopt links an existing task with no spawn and projects Inbox", async () => {
    const dir = scratch();
    const agent = fakeAgent();
    const service = new CollieService({ stateDir: dir, ruleset, agent: { run: agent.run } });
    const socket = await serve(service, dir);

    const response = await post(socket, "/ticket/adopt", {
      space: "collie", task_ref: "work-system-weaver#72", title: "Review miergo!168", kind: "review",
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ticket_ref: "work-system-weaver#72", adopted: true });
    expect(agent.calls).toEqual([]);
    const decision = service.ledger.history("decision").filter((item) => item.id === response.body.decision_id).at(-1);
    expect(decision).toMatchObject({ state: "open", actions: [], run: { task_ref: "work-system-weaver#72", kind: "review" } });
    expect(JSON.parse(readFileSync(join(dir, "queue.json"), "utf8")).decisions).toContainEqual(decision);

    const again = await post(socket, "/ticket/adopt", {
      space: "collie", task_ref: "work-system-weaver#72", title: "Review miergo!168", kind: "review",
    });
    expect(again.body).toMatchObject({ decision_id: response.body.decision_id, adopted: false });
  });

  test("adopt/receipt 共用最长 240 字 canonical ref，不退回 key/id", async () => {
    const dir = scratch();
    const service = new CollieService({ stateDir: dir, ruleset, agent: { run: async () => ({ tasks: [] }) } });
    const ref = `COLL-${"x".repeat(235)}`;
    const adopted = await service.adoptTicket({ space: "collie", task_ref: ref, title: "long canonical ref" });
    expect(adopted.ticket_ref).toBe(ref);
    await service.acceptReceipt(adopted.decision_id, {
      ...structuredClone(receiptFixture), id: "rc_longref01", decision_ref: adopted.decision_id,
      task: { ...receiptFixture.task, id: ref },
    });
    expect(service.ledger.receipts[0].task.id).toBe(ref);
    expect(service.ledger.decisions.find((item) => item.id === adopted.decision_id)?.run.task_ref).toBe(ref);
    await expect(service.adoptTicket({ space: "collie", task_ref: "x".repeat(241), title: "too long" })).rejects.toThrow("invalid task_ref");
  });

  test("adopted tasks recover folder through show before accept/done/start without workspace config", async () => {
    for (const option of ["accept", "drop"]) {
      const dir = scratch();
      const calls: string[][] = [];
      const service = new CollieService({
        stateDir: dir, ruleset: structuredClone(ruleset),
        agent: { run: async (args) => {
          if (args[0] !== "list") calls.push(args);
          if (args[0] === "show") return { folder: "/adopted" };
          return { state: "done" };
        } },
      });
      const adopted = await service.adoptTicket({ space: "collie", task_ref: "ADOPT-1", title: "adopted" });
      await service.acceptReceipt(adopted.decision_id, {
        ...structuredClone(receiptFixture), id: `rc_adopt${option}1`, decision_ref: adopted.decision_id,
        task: { ...receiptFixture.task, id: "ADOPT-1" },
      });
      const answered = await service.answerCard(adopted.decision_id, {
        option, at: "2026-11-13T11:00:00Z", by: "human",
      });
      expect(calls[0]).toEqual(["show", "ADOPT-1", "--json"]);
      expect(calls[1]).toEqual([
        option === "accept" ? "accept" : "done", "ADOPT-1", "--folder", "/adopted", "--json", "--done-by", "human",
      ]);
      expect(answered.decision.state).toBe("settled");
    }

    const dir = scratch();
    const calls: string[][] = [];
    const service = new CollieService({
      stateDir: dir, ruleset: structuredClone(ruleset),
      agent: { run: async (args) => {
        if (args[0] !== "list") calls.push(args);
        if (args[0] === "show" && !args.includes("--evidence")) return { folder: "/adopted" };
        if (args[0] === "start") return { state: "running" };
        return {
          state: "ready", started_at: 1, ready_at: 2,
          evidence: { summary: "adopted ready", details: "rework complete", commits: { list: [] }, proof: { id: "proof-adopted", title: "proof" } },
        };
      } },
    });
    const adopted = await service.adoptTicket({ space: "collie", task_ref: "ADOPT-1", title: "adopted" });
    await service.acceptReceipt(adopted.decision_id, {
      ...structuredClone(receiptFixture), id: "rc_adoptrework1", decision_ref: adopted.decision_id,
      task: { ...receiptFixture.task, id: "ADOPT-1" },
    });
    const reworked = await service.answerCard(adopted.decision_id, {
      option: "rework", at: "2026-11-13T11:00:00Z", by: "human", annotations: [{ file: "review", note: "retry" }],
    }, "machine/t88", async () => ({}));
    expect(calls.map((call) => call[0])).toEqual(["show", "start", "show", "show"]);
    expect(calls[1]).toEqual(["start", "ADOPT-1", "--folder", "/adopted", "--space", "collie", "--json"]);
    expect(calls.at(-1)).toEqual(["show", "ADOPT-1", "--folder", "/adopted", "--json", "--evidence"]);
    expect(reworked.decision).toMatchObject({ state: "waiting", run: { task_ref: "ADOPT-1" } });
    expect(service.ledger.receipts).toHaveLength(2);
  });
});

describe("project-aware ticket", () => {
  test("project selects the repo folder and task ref becomes PROJECT-<id>", async () => {
    const dir = scratch();
    const project = join(dir, "projects", "collie");
    // The service validates the folder only; collie-task owns the actual git/worktree.
    mkdirSync(project, { recursive: true });
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      if (args[0] !== "list") calls.push(args);
      if (args[0] === "add") return { id: 7, key: "work-system-weaver-projects-collie#7", ref: "COLLIE-7" };
      if (args[0] === "start") return { id: 7, state: "running" };
      if (args[0] === "list") return [];
      return {
        id: 7, key: "work-system-weaver-projects-collie#7", ref: "COLLIE-7",
        state: "ready", started_at: 1_763_664_030_000, ready_at: 1_763_666_480_000,
        evidence: { summary: "done", details: "- review", commits: { list: [["abc1234", "x"]] }, proof: { id: "proof-7", title: "proof" } },
      };
    };
    const service = new CollieService({
      stateDir: dir, ruleset, agent: { run },
      workspaces: { "system-weaver": { folder: dir, projects: { collie: project } } },
    });
    const socket = await serve(service, dir);
    const response = await post(socket, "/ticket", {
      space: "system-weaver", project: "collie", title: "Review collie", brief: "review it", kind: "review",
    });
    expect(response.status).toBe(200);
    expect(response.body.ticket_ref).toBe("COLLIE-7");
    const add = calls.find((call) => call[0] === "add")!;
    expect(add).toContain("--folder");
    expect(add[add.indexOf("--folder") + 1]).toBe(project);
    expect(add).toContain(`playbook=review@${service.collaboration.playbook("review").version}`);
    const created = service.ledger.history("decision").filter((item) => item.id === response.body.decision_id).at(-1);
    expect(created.project).toBe("collie");
    expect(created.run.task_ref).toBe("COLLIE-7");
  });

  test("an unknown project is rejected before spawning", async () => {
    const dir = scratch();
    const agent = fakeAgent();
    const service = new CollieService({
      stateDir: dir, ruleset, agent: { run: agent.run },
      workspaces: { collie: { folder: "/repo/collie" } },
    });
    const socket = await serve(service, dir);
    const response = await post(socket, "/ticket", {
      space: "collie", project: "missing", title: "x", brief: "y",
    });
    expect(response.status).toBe(400);
    expect(agent.calls).toEqual([]);
  });
});

describe("public task command surface", () => {
  test("rejects vendor-only task subcommands before touching the task store", async () => {
    const dir = scratch();
    for (const command of ["review", "verify", "merge", "assistants", "tell-assistant", "tick"]) {
      const child = Bun.spawn([
        python, join(root, "bin", "collie"), "task", "--root", dir, command,
      ], { stdout: "pipe", stderr: "pipe" });
      const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(2);
      expect(stderr).toContain("add/list/show/start/status/ready/accept/done");
    }
  });
});

describe("coordinator chat decision commit", () => {
  test("commits the same Decision contract as the event helper", async () => {
    const dir = scratch();
    const service = new CollieService({
      stateDir: dir, ruleset,
      agent: { run: async () => ({ tasks: [] }) },
      workspaces: { collie: { folder: "/repo/collie" } },
    });
    const socket = await serve(service, dir);
    const response = await post(socket, "/decision", {
      space: "collie",
      decision: {
        state: "settled", why: "human chat needs no work", actions: [],
        settled: { at: new Date().toISOString(), by: "coordinator", outcome: "dropped" },
        run: { kind: "build" },
      },
    });
    expect(response.status).toBe(200);
    const decision = service.ledger.history("decision").at(-1)!;
    expect(decision).toMatchObject({
      origin: "human", decided_by: "coordinator", playbook: { name: "feature", version: 4 },
    });
    expect(response.body).toMatchObject({ origin: "human", state: "settled", event_ref: null, key: "human:turn:untracked" });
    expect(service.ledger.events).toHaveLength(0);
    expect(service.ledger.messages).toHaveLength(1);
  });
});

describe("decision delivery errors", () => {
  test("returns a structured correctable error and keeps a retry idempotent", async () => {
    const dir = scratch();
    const service = new CollieService({
      stateDir: dir, ruleset,
      agent: { run: async () => ({ tasks: [] }) },
      workspaces: { collie: { folder: "/repo/collie" } },
    });
    const socket = await serve(service, dir);
    const base = {
      state: "settled", why: "noop", actions: [],
      settled: { at: new Date().toISOString(), by: "coordinator", outcome: "dropped" },
      run: { kind: "build" },
    };
    const bad = await post(socket, "/decision", {
      space: "collie", turn_id: "turn-retry-1",
      decision: { ...base, playbook: { name: "missing", version: 1 } },
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({
      ok: false,
      error: { code: "unknown_playbook", field: "playbook.name", retryable: false, max_attempts: 3 },
    });

    const payload = { space: "collie", turn_id: "turn-retry-1", decision: base };
    const first = await post(socket, "/decision", payload);
    const second = await post(socket, "/decision", payload);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(service.ledger.decisions.filter((item) => item.id === first.body.id)).toHaveLength(1);
  });
});
