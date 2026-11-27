import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { once } from "node:events";
import { CollieService } from "../service/main.ts";
import { startAnswerServer, startIngressServer } from "../service/answer-server.ts";
import { answerCard as authorizeCard } from "../protocol/invariants.mjs";

const event = await Bun.file(new URL("../protocol/fixtures/event.json", import.meta.url)).json();
const ruleset = await Bun.file(new URL("../protocol/fixtures/ruleset.json", import.meta.url)).json();
const decisionFixture = await Bun.file(new URL("../protocol/fixtures/decision.json", import.meta.url)).json();
const emptyTaskStore = async () => ({ tasks: [] });
const paths: string[] = [];
const servers: any[] = [];
afterEach(() => {
  while (servers.length) servers.pop().close();
  while (paths.length) rmSync(paths.pop()!, { recursive: true, force: true });
});

function post(socketPath: string, body: unknown, path = "/answer", headers: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: "POST", headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

describe("Inbox detail answer socket", () => {
  test("drop 只通过 Card.answer 关闭 Decision，不经过 herdr-task", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-answer-"));
    paths.push(dir);
    const service = new CollieService({ stateDir: dir, ruleset, agent: { run: emptyTaskStore } });
    const decisions = await service.process(event);
    const socket = join(dir, "service.sock");
    const server = startAnswerServer(service, socket);
    servers.push(server);
    if (!server.listening) await once(server, "listening");

    const response = await post(socket, {
      decisionId: decisions[0].id,
      answer: { option: "drop", at: "2026-11-13T11:00:00Z", by: "human" },
    });
    expect(response.status).toBe(200);
    expect(response.body.decision.state).toBe("settled");
    expect(response.body.decision.settled.outcome).toBe("dropped");
    expect(response.body.decision.card.answer.by).toBe("human");
    expect(service.ledger.waiting()).toEqual([]);
    expect(service.ledger.decisions[0].occurrence.hops).toBe(0);
  });

  test("accept/archive 在 Task 已不存在时仍结算 Decision", async () => {
    for (const option of ["accept", "archive"]) {
      const dir = mkdtempSync(join(tmpdir(), "collie-answer-missing-task-"));
      paths.push(dir);
      const run = async (args: string[]) => {
        if (args[0] === "accept" || args[0] === "done") throw new Error(`Command failed: collie-task ${args[0]} COLL-915`);
        if (args[0] === "show") throw new Error(`No task COLL-915 in /tmp`);
        if (args[0] === "list") return [{ folder: "/tmp", tasks: [] }];
        throw new Error(`unexpected task command: ${args.join(" ")}`);
      };
      const service = new CollieService({
        stateDir: dir, ruleset, workspaces: { collie: { folder: "/tmp", projects: { collie: "/tmp" } } }, agent: { run },
      });
      const decision = await service.commitDecision({
        space: "collie", project: "collie", turn_id: `missing-task-${option}`,
        decision: {
          ...decisionFixture,
          state: "waiting", run: { task_ref: "COLL-915", coordinator_ref: null }, receipt_ref: "rc_missing",
          actions: [{ kind: "noop", risk_tags: [] }],
          card: {
            kind: "accept", question: "Task already missing", options: ["accept", "rework", "archive"],
            state: "open", created_at: "2026-11-13T10:00:00Z", acked_at: null, answer: null,
            snooze_until: null, closed_at: null,
          },
        },
      });
      const result = await service.answerCard(decision.id, { option, at: "2026-11-13T11:00:00Z", by: "human" });
      expect(result.decision.state).toBe("settled");
      expect(result.decision.settled.outcome).toBe(option === "accept" ? "accepted" : "archived");
    }
  });
});

function get(socketPath: string, path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: "GET" }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("TCP ingress surface", () => {
  test("TCP listener exposes only /v1/ingress and /v1/in/<source>", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-ingress-surface-"));
    paths.push(dir);
    const service = new CollieService({ stateDir: dir, ruleset, agent: { run: emptyTaskStore } });
    const server = startIngressServer(service, 0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as any).port;
    const post = (path: string) => fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect((await post("/ticket")).status).toBe(404);
    expect((await post("/decision")).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    expect((await post("/v1/ingress")).status).toBe(401);
  });
});

describe("Native event ingress", () => {
  test("only /v1/ingress and /v1/in/<source> are public ingress contracts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-ingress-surface-"));
    paths.push(dir);
    const service = new CollieService({ stateDir: dir, ruleset, agent: { run: emptyTaskStore } });
    const socket = join(dir, "service.sock");
    const server = startAnswerServer(service, socket);
    servers.push(server);
    if (!server.listening) await once(server, "listening");
    for (const path of ["/message", "/request"]) {
      const response = await post(socket, { space: "collie", goal: "status?" }, path);
      expect(response.status).toBe(404);
    }
  });

  test("POST /v1/ingress accepts and dispatches a Collie Event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-ingress-"));
    paths.push(dir);
    const service = new CollieService({ stateDir: dir, ruleset, agent: { run: emptyTaskStore } });
    const socket = join(dir, "service.sock");
    const server = startAnswerServer(service, socket);
    servers.push(server);
    if (!server.listening) await once(server, "listening");

    const response = await post(socket, event, "/v1/ingress");
    expect(response.status).toBe(200);
    expect(["accepted", "merged", "duplicate", "recorded"]).toContain(response.body.status);
    expect(response.body.event.source).toBe(event.source);
    expect(Array.isArray(response.body.decisions)).toBe(true);
  });
});

describe("HTTP delivery and authenticated client space", () => {
  test("POST /deliver calls service delivery once after authorization and retries without duplicate egress", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-deliver-http-"));
    paths.push(dir);
    const payload = join(dir, "payload.json");
    writeFileSync(payload, JSON.stringify({ repo: "example/collie", id: 93, body: "LGTM" }));
    const external: string[][] = [];
    const service = new CollieService({
      stateDir: dir, ruleset, agent: { run: emptyTaskStore },
      delivery: { gitlab: async (args) => { external.push(args); return {}; } },
      decide: () => ({ state: "open", why: "authorized comment", actions: [{
        kind: "emit_command", risk_tags: ["outbound_message"],
        egress: { target: "gitlab", op: "comment", payload_ref: payload },
      }] }),
    });
    const waiting = (await service.process(event))[0];
    service.ledger.append("decision", authorizeCard(waiting, {
      option: "accept", at: "2026-11-13T11:00:00Z", by: "human",
    }));
    const socket = join(dir, "service.sock");
    const server = startAnswerServer(service, socket);
    servers.push(server);
    if (!server.listening) await once(server, "listening");

    const first = await post(socket, { decisionId: waiting.id }, "/deliver");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ state: "settled", settled: { outcome: "commented" } });
    expect(external).toHaveLength(1);
    const second = await post(socket, { decisionId: waiting.id }, "/deliver");
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(waiting.id);
    expect(external).toHaveLength(1);
  });

  test("authenticated client space defaults only Events without an explicit space", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-client-space-"));
    paths.push(dir);
    writeFileSync(join(dir, "sources.json"), JSON.stringify({
      clients: { automation: { token: "secret", space: "configured" } },
    }));
    const service = new CollieService({ stateDir: dir, configDir: dir, ruleset, agent: { run: emptyTaskStore } });
    const socket = join(dir, "service.sock");
    const server = startAnswerServer(service, socket);
    servers.push(server);
    if (!server.listening) await once(server, "listening");
    const withoutSpace = structuredClone(event);
    delete withoutSpace.space_candidates;
    const response = await post(socket, withoutSpace, "/v1/ingress", { authorization: "Bearer secret" });
    expect(response.status).toBe(200);
    expect(response.body.event.space_candidates).toEqual(["configured"]);

    const explicit = { ...structuredClone(event), id: "ev_explicits01", key: "explicit-space", space_candidates: ["explicit"] };
    const preserved = await post(socket, explicit, "/v1/ingress", { authorization: "Bearer secret" });
    expect(preserved.status).toBe(200);
    expect(preserved.body.event.space_candidates).toEqual(["explicit"]);
  });
});

describe("Source adapter ingress", () => {
  test("POST /v1/in/gitlab verifies the source secret and adapts the payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-source-http-"));
    paths.push(dir);
    writeFileSync(join(dir, "sources.json"), JSON.stringify({
      sources: { gitlab: { adapter: "gitlab", secret: "secret", space_map: { "olap/miergo": "spf57" } } },
    }));
    const service = new CollieService({ stateDir: dir, configDir: dir, ruleset, agent: { run: emptyTaskStore } });
    const socket = join(dir, "service.sock");
    const server = startAnswerServer(service, socket);
    servers.push(server);
    if (!server.listening) await once(server, "listening");
    const payload = {
      object_kind: "merge_request",
      project: { path_with_namespace: "olap/miergo", web_url: "https://git.n.xiaomi.com/olap/miergo" },
      object_attributes: { iid: 169, title: "ALTER operator/clientId", url: "https://git.n.xiaomi.com/olap/miergo/-/merge_requests/169", action: "update" },
    };
    const response = await post(socket, payload, "/v1/in/gitlab", { "x-gitlab-token": "secret", "x-gitlab-event-uuid": "uuid-1" });
    expect(response.status).toBe(200);
    expect(response.body.event).toMatchObject({ source: "gitlab", object: { kind: "mr", id: "mr!169" } });
    expect(response.body.event.space_candidates).toEqual(["spf57"]);
  });

  test("GET /v1/events/:id returns event and decisions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-event-status-"));
    paths.push(dir);
    const service = new CollieService({ stateDir: dir, ruleset, agent: { run: emptyTaskStore } });
    const socket = join(dir, "service.sock");
    const server = startAnswerServer(service, socket);
    servers.push(server);
    if (!server.listening) await once(server, "listening");
    const accepted = await post(socket, event, "/v1/ingress");
    const response = await get(socket, `/v1/events/${accepted.body.event.id}`);
    expect(response.status).toBe(200);
    expect(response.body.event.id).toBe(accepted.body.event.id);
    expect(Array.isArray(response.body.decisions)).toBe(true);
  });
});

describe("Collie service health", () => {
  test("GET /health reports the running service", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-health-"));
    paths.push(dir);
    const service = new CollieService({ stateDir: dir, ruleset, agent: { run: emptyTaskStore } });
    const socket = join(dir, "service.sock");
    const server = startAnswerServer(service, socket);
    servers.push(server);
    if (!server.listening) await once(server, "listening");

    const response = await get(socket, "/health");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, service: "collie", state_dir: dir });
    expect(response.body.pid).toBeGreaterThan(0);
    expect(response.body.uptime_ms).toBeGreaterThanOrEqual(0);
  });
});
