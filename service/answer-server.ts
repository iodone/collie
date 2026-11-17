import { createServer } from "node:http";
import type { InboxService } from "./main.ts";

export function startAnswerServer(service: InboxService, socketPath: string) {
  const startedAt = Date.now();
  return createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        service: "collie",
        pid: process.pid,
        uptime_ms: Date.now() - startedAt,
        state_dir: service.stateDir,
        decisions: service.ledger.decisions.length,
      }));
      return;
    }
    if (request.method !== "POST" || !["/answer", "/request"].includes(request.url ?? "")) {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 65_536) request.destroy(new Error("answer body too large"));
    });
    request.on("end", async () => {
      try {
        const input = JSON.parse(body);
        const result = request.url === "/request"
          ? await service.request(input.space, input.goal, input.ticket_refs ?? [])
          : await service.answerCard(input.decisionId, input.answer, input.coordinatorAddress);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
  }).listen(socketPath);
}
