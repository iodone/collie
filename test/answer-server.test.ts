import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { CollieService } from "../service/main.ts";
import { startAnswerServer } from "../service/answer-server.ts";

const event = await Bun.file(new URL("../protocol/fixtures/event.json", import.meta.url)).json();
const ruleset = await Bun.file(new URL("../protocol/fixtures/ruleset.json", import.meta.url)).json();
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
    const service = new CollieService({ stateDir: dir, ruleset });
    const decisions = await service.process(event);
    const socket = join(dir, "service.sock");
    servers.push(startAnswerServer(service, socket));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const response = await post(socket, {
      decisionId: decisions[0].id,
      answer: { option: "drop", at: "2026-11-13T11:00:00Z", by: "human" },
    });
    expect(response.status).toBe(200);
    expect(response.body.decision.state).toBe("settled");
    expect(response.body.decision.settled.outcome).toBe("dropped");
    expect(response.body.decision.card.answer.by).toBe("human");
    expect(response.body.resumed).toBe(false);
    expect(service.ledger.waiting()).toEqual([]);
    expect(service.ledger.decisions[0].occurrence.hops).toBe(0);
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

describe("Native event ingress", () => {
  test("POST /v1/ingress accepts and dispatches a Collie Event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-ingress-"));
    paths.push(dir);
    const service = new CollieService({ stateDir: dir, ruleset });
    const socket = join(dir, "service.sock");
    servers.push(startAnswerServer(service, socket));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const response = await post(socket, event, "/v1/ingress");
    expect(response.status).toBe(200);
    expect(["accepted", "merged", "duplicate", "recorded"]).toContain(response.body.status);
    expect(response.body.event.source).toBe(event.source);
    expect(Array.isArray(response.body.decisions)).toBe(true);
  });
});

describe("Source adapter ingress", () => {
  test("POST /v1/in/gitlab verifies the source secret and adapts the payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-source-http-"));
    paths.push(dir);
    writeFileSync(join(dir, "sources.json"), JSON.stringify({
      sources: { gitlab: { adapter: "gitlab", secret: "secret", space_map: { "olap/miergo": "spf57" } } },
    }));
    const service = new CollieService({ stateDir: dir, configDir: dir, ruleset });
    const socket = join(dir, "service.sock");
    servers.push(startAnswerServer(service, socket));
    await new Promise((resolve) => setTimeout(resolve, 10));
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
    const service = new CollieService({ stateDir: dir, ruleset });
    const socket = join(dir, "service.sock");
    servers.push(startAnswerServer(service, socket));
    await new Promise((resolve) => setTimeout(resolve, 10));
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
    const service = new CollieService({ stateDir: dir, ruleset });
    const socket = join(dir, "service.sock");
    servers.push(startAnswerServer(service, socket));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const response = await get(socket, "/health");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, service: "collie", state_dir: dir });
    expect(response.body.pid).toBeGreaterThan(0);
    expect(response.body.uptime_ms).toBeGreaterThanOrEqual(0);
  });
});
