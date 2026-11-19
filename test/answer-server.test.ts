import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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

function post(socketPath: string, body: unknown, path = "/answer"): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: "POST" }, (res) => {
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
