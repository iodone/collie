import { createServer } from "node:http";
import type { CollieService } from "./main.ts";

export function startAnswerServer(service: CollieService, socketPath: string) {
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
    if (request.method !== "POST" || !["/answer", "/request", "/ticket", "/ticket/adopt", "/v1/ingress"].includes(request.url ?? "")) {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_048_576) request.destroy(new Error("request body too large"));
    });
    request.on("end", async () => {
      try {
        const input = JSON.parse(body);
        const result = request.url === "/v1/ingress"
          ? await service.handleEvent(input)
          : request.url === "/request"
          ? await service.request(input.space, input.goal, input.ticket_refs ?? [])
          : request.url === "/ticket"
            ? await service.createTicket({ space: input.space, title: input.title, brief: input.brief, kind: input.kind })
            : request.url === "/ticket/adopt"
              ? await service.adoptTicket({ space: input.space, task_ref: input.task_ref, title: input.title, brief: input.brief, kind: input.kind })
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
