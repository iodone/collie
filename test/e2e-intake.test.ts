import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollieService } from "../service/main.ts";
import { startAnswerServer } from "../service/answer-server.ts";

const ruleset = await Bun.file(new URL("../protocol/fixtures/ruleset.json", import.meta.url)).json();
const root = new URL("..", import.meta.url).pathname;
const python = Bun.which("python3") ?? "python3";
const paths: string[] = [];
const servers: ReturnType<typeof startAnswerServer>[] = [];

afterEach(() => {
  while (servers.length) servers.pop()!.close();
  while (paths.length) rmSync(paths.pop()!, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "collie-e2e-intake-"));
  paths.push(dir);
  return dir;
}

function serve(service: CollieService, dir: string): Promise<string> {
  const socket = join(dir, "service.sock");
  const server = startAnswerServer(service, socket);
  servers.push(server);
  const { promise, resolve } = Promise.withResolvers<void>();
  if (server.listening) resolve();
  else server.once("listening", () => resolve());
  return promise.then(() => socket);
}

function nativeIntake(socket: string, envelope: unknown): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = Bun.spawn([
      python, join(root, "bin", "collie"), "intake", "event",
      "--state-dir", join(socket, ".."), "--space", "system-weaver", "--file", "-",
    ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(JSON.stringify(envelope));
    child.stdin.end();
    Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).then(([stdout, stderr, code]) => resolve({ code, stdout, stderr }), reject);
  });
}

describe("Collie native client e2e", () => {
  test("collie intake event -> /v1/ingress -> Event/Decision, without flume", async () => {
    const dir = scratch();
    const service = new CollieService({
      stateDir: dir,
      ruleset,
      agent: { run: async () => ({ tasks: [] }) },
      decide: () => ({
        state: "settled", why: "e2e intake accepted",
        actions: [], settled: { at: new Date().toISOString(), by: "coordinator", outcome: "dropped" },
      }),
    });
    const socket = await serve(service, dir);

    const result = await nativeIntake(socket, {
      native_id: "native-e2e-1",
      event: "merge_request.approved",
      occurred_at: "2026-11-19T12:00:00+00:00",
      source: "gitlab",
      subject: "group/collie!1",
      payload: { object_attributes: { iid: 1 } },
    });

    expect(result.code).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.status).toBe("accepted");
    expect(response.event).toMatchObject({
      source: "gitlab", key: "native-e2e-1", type: "merge_request.approved",
      object: { kind: "none", id: "group/collie!1" },
      project: "collie", space_candidates: ["system-weaver"],
    });
    expect(response.decisions).toHaveLength(1);
    expect(response.decisions[0]).toMatchObject({ state: "settled", project: "collie" });
    expect(service.ledger.events).toHaveLength(1);
    expect(service.ledger.decisions).toHaveLength(1);
  });

  test("native client can target a project and spawn against that project folder", async () => {
    const dir = scratch();
    const project = join(dir, "projects", "collie");
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      if (args[0] !== "list") calls.push(args);
      if (args[0] === "add") return { id: 1, key: "work-system-weaver-projects-collie#1", ref: "COLL-1" };
      if (args[0] === "start") return { id: 1, state: "running" };
      if (args[0] === "list") return [];
      return {
        id: 1, key: "work-system-weaver-projects-collie#1", ref: "COLL-1",
        state: "ready", started_at: 1_763_664_030_000, ready_at: 1_763_666_480_000,
        evidence: { summary: "done", details: "- review", commits: { list: [["abc1234", "x"]] }, proof: { id: "proof-e2e", title: "proof" } },
      };
    };
    const { mkdirSync } = await import("node:fs");
    mkdirSync(project, { recursive: true });
    const service = new CollieService({
      stateDir: dir, ruleset, agent: { run },
      workspaces: { "system-weaver": { folder: dir, projects: { collie: project } } },
      decide: (job) => job.message.type === "task.ready" ? ({
        state: "settled", why: "ready proof accepted", actions: [{ kind: "noop", risk_tags: [] }],
        settled: { at: new Date().toISOString(), by: "coordinator", outcome: "accepted" },
      }) : ({
        state: "open", why: "review collie", project: "collie",
        actions: [{
          kind: "spawn_task", risk_tags: [],
          spawn: { title: "review collie", brief_ref: "/tmp/brief.md", base: "current", access: "read" },
        }],
        run: { kind: "review" },
      }),
    });
    // A real brief path is rendered by the kernel; the fake agent never reads it.
    const socket = await serve(service, dir);
    const result = await nativeIntake(socket, {
      native_id: "native-e2e-project",
      event: "merge_request.approved",
      occurred_at: "2026-11-19T12:00:00+00:00",
      source: "gitlab",
      subject: "group/collie!2",
      payload: {},
    });
    expect(result.code).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.event.project).toBe("collie");
    const add = calls.find((call) => call[0] === "add");
    expect(add).toBeDefined();
    expect(add![add!.indexOf("--folder") + 1]).toBe(project);
    expect(response.decisions[0].run.task_ref).toBe("COLL-1");
    expect(response.decisions[0].state).toBe("settled");
    expect(calls.map((call) => call[0])).toEqual(["add", "start", "show", "accept"]);
    expect(calls.at(-1)).toContain("COLL-1");
  });
});
