import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CollieService } from "./main.ts";
import { clientAuth, loadIngressConfig, secretOf } from "./ingress-config.ts";
import { sourceEvent, verifySource } from "./sources.ts";
import { intakeEvent } from "./intake.ts";

const MAX_BODY = 1_048_576;
const routes = ["/answer", "/request", "/ticket", "/ticket/adopt", "/v1/ingress"];

function send(response: ServerResponse, status: number, value: unknown): void {
  if (!response.headersSent) response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) request.destroy(new Error("request body too large"));
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

/** One HTTP surface for the Unix socket and the optional ingress listener. */
export function serviceHandler(service: CollieService, { requireClientAuth = false, requireSecrets = false }: { requireClientAuth?: boolean; requireSecrets?: boolean } = {}) {
  const startedAt = Date.now();
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = (request.url ?? "").split("?")[0];
    try {
      if (request.method === "GET" && url === "/health") {
        send(response, 200, {
          ok: true, service: "collie", pid: process.pid,
          uptime_ms: Date.now() - startedAt, state_dir: service.stateDir,
          decisions: service.ledger.decisions.length,
        });
        return;
      }
      if (request.method === "GET" && url.startsWith("/v1/events/")) {
        const id = decodeURIComponent(url.slice("/v1/events/".length));
        const status = service.eventStatus(id);
        if (!status) return send(response, 404, { error: "event not found" });
        send(response, 200, status);
        return;
      }
      if (request.method !== "POST") return send(response, 404, { error: "not found" });

      const body = await readBody(request);
      const input = JSON.parse(body || "{}");

      if (url.startsWith("/v1/in/")) {
        const name = decodeURIComponent(url.slice("/v1/in/".length));
        const config = loadIngressConfig(service.configDir);
        const source = config.sources?.[name];
        if (!source || source.enabled === false) return send(response, 404, { error: "source not configured" });
        const adapter = source.adapter ?? name;
        if ((requireSecrets && !secretOf(source)) || !verifySource(adapter, request.headers, body, secretOf(source))) return send(response, 401, { error: "bad source signature" });
        const event = sourceEvent(adapter, source, request.headers, body, service.stateDir);
        return send(response, 200, await service.handleEvent(event));
      }

      if (!routes.includes(url)) return send(response, 404, { error: "not found" });
      if (url === "/v1/ingress") {
        const config = loadIngressConfig(service.configDir);
        // A local socket with no configured clients is trusted; any remote listener must configure a client token.
        if ((requireClientAuth || Object.keys(config.clients ?? {}).length) && !clientAuth(config, request.headers.authorization).ok) {
          return send(response, 401, { error: "bad ingress token" });
        }
        return send(response, 200, await service.handleEvent(intakeEvent(input, service.stateDir)));
      }

      const result = url === "/request"
        ? await service.request(input.space, input.goal, input.ticket_refs ?? [])
        : url === "/ticket"
          ? await service.createTicket({ space: input.space, project: input.project, title: input.title, brief: input.brief, kind: input.kind })
          : url === "/ticket/adopt"
            ? await service.adoptTicket({ space: input.space, task_ref: input.task_ref, title: input.title, brief: input.brief, kind: input.kind })
            : await service.answerCard(input.decisionId, input.answer, input.coordinatorAddress);
      send(response, 200, result);
    } catch (error) {
      send(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}

export function startAnswerServer(service: CollieService, socketPath: string) {
  return createServer(serviceHandler(service)).listen(socketPath);
}

/** Optional TCP ingress; intended for clients that cannot reach the local Unix socket. */
export function startIngressServer(service: CollieService, port: number, host = "127.0.0.1") {
  return createServer(serviceHandler(service, { requireClientAuth: true, requireSecrets: true })).listen(port, host);
}
