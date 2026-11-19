import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { Ingress, type Dispatch } from "../kernel/ingress.ts";
import { Ledger, ledgerId } from "../kernel/ledger.ts";
import { coordinate } from "../kernel/coordinator.ts";
import { renderBrief } from "../kernel/brief.ts";
import { runHerdrTask, type HerdrAgentOptions } from "../plugins/agent/herdr.ts";
import { answerHerdrCard, type ChannelRunner } from "../plugins/channel/herdr.ts";
import { deliverGitlab } from "../plugins/delivery/gitlab.ts";
import { deliverGithub } from "../plugins/delivery/github.ts";
import { deliverIm } from "../plugins/delivery/im.ts";
import type { DeliveryRunner } from "../plugins/delivery/common.ts";
import { startAnswerServer, startIngressServer } from "./answer-server.ts";
import { coordinatorConfig, type CoordinatorRunner } from "../plugins/agent/coordinator.ts";
import { defaultHelperRunner, enqueueHelperJob, ensureHelper, listCoordinators, runHelperJob, type HelperRunner } from "../plugins/agent/helper.ts";
import { createHash } from "node:crypto";

type Json = Record<string, any>;

export type WorkspaceConfig = { folder: string; cli?: string; projects?: Record<string, string> };

export interface CollieServiceOptions {
  stateDir: string;
  configDir?: string;
  ruleset: Json;
  decide?: (job: Json) => Promise<Json> | Json;
  agent?: HerdrAgentOptions;
  now?: () => Date;
  rolePromptRef?: string;
  workspaces?: Record<string, WorkspaceConfig>;
  delivery?: { gitlab?: DeliveryRunner; github?: DeliveryRunner; im?: DeliveryRunner };
  coordinator?: { settings?: Json; settingsPath?: string; run?: CoordinatorRunner };
  helper?: { run?: HelperRunner; timeoutMs?: number; pollIntervalMs?: number; bootWaitMs?: number };
}

export class CollieService {
  readonly ledger: Ledger;
  readonly ingress: Ingress;
  readonly stateDir: string;
  readonly configDir: string;
  readonly #options: CollieServiceOptions;

  constructor(options: CollieServiceOptions) {
    this.#options = options;
    this.stateDir = resolve(options.stateDir);
    this.configDir = resolve(options.configDir ?? join(homedir(), ".config", "collie"));
    mkdirSync(this.stateDir, { recursive: true });
    mkdirSync(this.configDir, { recursive: true });
    this.ledger = Ledger.open(join(this.stateDir, "ledger.json"));
    this.ingress = new Ingress();
    const snapshotPath = join(this.stateDir, "ingress.json");
    if (existsSync(snapshotPath)) this.ingress.restore(JSON.parse(readFileSync(snapshotPath, "utf8")));
  }

  #projectIngress(): void {
    const path = join(this.stateDir, "ingress.json");
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.ingress.snapshot()), { mode: 0o600 });
    renameSync(temporary, path);
  }

  #projectQueue(): void {
    const path = join(this.stateDir, "queue.json");
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ decisions: this.ledger.decisions }), { mode: 0o600 });
    renameSync(temporary, path);
  }

  #projectFolder(space: string, project?: string): string {
    const workspace = this.#options.workspaces?.[space];
    if (!workspace?.folder) throw new Error(`no worker workspace configured for space ${space}`);
    if (!project) return workspace.folder;
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(project)) throw new Error("invalid project");
    const configured = workspace.projects?.[project];
    const folder = resolve(configured ?? join(workspace.folder, "projects", project));
    if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error(`no project folder configured for ${space}/${project}`);
    return folder;
  }

  /** The one event boundary: validate, dedupe, merge, dispatch, and project. */
  async handleEvent(event: Json): Promise<{ status: string; event: Json; decisions: Json[] }> {
    const result = this.ingress.ingest(event);
    const normalized = result.dispatches.length ? result.dispatches.map((dispatch) => dispatch.event) : [result.event];
    for (const item of normalized) this.ledger.append("event", item);
    this.#projectIngress();
    this.#projectQueue();
    const decisions = [];
    for (const dispatch of result.dispatches) decisions.push(await this.#dispatch(dispatch));
    this.#projectQueue();
    return { status: result.status, event: result.event, decisions };
  }

  async process(event: Json): Promise<Json[]> {
    return (await this.handleEvent(event)).decisions;
  }

  /** Event status for ingress clients: the durable Event and every Decision it produced. */
  eventStatus(eventId: string): Json | null {
    const event = this.ledger.events.find((item) => item.id === eventId);
    if (!event) return null;
    const key = `${event.source}:${event.key}`;
    const decisions = this.ledger.decisions.filter((item) => item.event_ref === event.id || item.key === key);
    return { event, decisions };
  }

  #policy(space: string): string {
    for (const path of [join(this.stateDir, "policy", `${space}.md`), join(this.stateDir, "policy.md")]) {
      try { return readFileSync(path, "utf8").slice(0, 2000); } catch {}
    }
    return "";
  }

  #coordinatorSettings(): Json {
    if (this.#options.coordinator?.settingsPath && existsSync(this.#options.coordinator.settingsPath)) {
      return JSON.parse(readFileSync(this.#options.coordinator.settingsPath, "utf8"));
    }
    return this.#options.coordinator?.settings ?? {};
  }

  #agentOptions(decision: Json): HerdrAgentOptions {
    return {
      ...this.#options.agent,
      onSpawn: async (task) => {
        const latest = this.ledger.decisions.find((item) => item.id === decision.id) ?? decision;
        this.ledger.append("decision", { ...latest, state: "open", run: { ...latest.run, task_ref: task.ref ?? task.key ?? task.id } });
        this.#projectQueue();
        await this.#options.agent?.onSpawn?.(task);
      },
    };
  }

  async #executeSpawn(decision: Json, dispatch: Dispatch): Promise<Json> {
    const spawns = decision.actions.filter((action: Json) => action.kind === "spawn_task");
    if (decision.state !== "open" || !spawns.length) return decision;
    if (spawns.length !== 1) throw new Error("M1 executes exactly one spawn_task per decision");
    // The kernel renders the trusted brief; the coordinator only points at data.
    const brief = renderBrief(dispatch, join(this.stateDir, "briefs"));
    const executed = {
      ...decision,
      actions: decision.actions.map((action: Json) => action.kind === "spawn_task"
        ? { ...action, spawn: { ...action.spawn, brief_ref: brief } }
        : action),
    };
    this.ledger.append("decision", executed);
    this.#projectQueue();
    decision = executed;
    const workspace = this.#options.workspaces?.[decision.space];
    if (!workspace) throw new Error(`no worker workspace configured for space ${decision.space}`);
    const folder = this.#projectFolder(decision.space, decision.project);
    const rule = {
      to: { kind: "herdr_task", space: decision.space, ...(decision.project ? { project: decision.project } : {}), cwd: { path: folder, kind: "git" } },
      agent: { ...(workspace.cli ? { cli: workspace.cli } : {}) },
    };
    const receipt = await runHerdrTask(decision, rule, this.#agentOptions(decision));
    return this.acceptReceipt(decision.id, receipt);
  }

  async request(space: string, goal: string, ticketRefs: string[] = []): Promise<Json> {
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(space)) throw new Error("invalid space");
    if (typeof goal !== "string" || !goal.trim() || goal.length > 4000) throw new Error("goal must be 1–4000 chars");
    const at = (this.#options.now ?? (() => new Date()))().toISOString();
    const id = ledgerId("ev");
    const directory = join(this.stateDir, "requests");
    mkdirSync(directory, { recursive: true });
    const dataRef = join(directory, `${id}.md`);
    const requestBody = JSON.stringify({ goal, ticket_refs: ticketRefs });
    writeFileSync(dataRef, requestBody, { mode: 0o600 });
    const event = {
      id, source: "im", key: `human:${id}`, type: "human.requested",
      object: { kind: "none", id }, title: goal.split(/\r?\n/)[0].slice(0, 80).replace(/^[-\s]+/, "Request "),
      data_ref: dataRef, data_digest: `sha256:${createHash("sha256").update(requestBody).digest("hex")}`,
      hops: 0, received_at: at,
      merge: { lane_key: `coordinator:none:${id}`, object_key: `none:${id}`, first_seen_at: at, occurrences: 1 },
      space_candidates: [space],
    };
    const dispatch: Dispatch = { kind: "coordinator", laneKey: event.merge.lane_key, space, event };
    const decision = await coordinate(dispatch, {
      ledger: this.ledger, ruleset: this.#options.ruleset, stream: "chat_turn",
      policy: this.#policy(space),
      onDecision: () => this.#projectQueue(),
      spaceNote: ticketRefs.length ? `引用 Ticket：${ticketRefs.join("、")}` : `${space} · coordinator`,
      decide: this.#options.decide ?? (async (job: Json) => {
        if (!this.#options.coordinator) throw new Error(`space ${space} has no coordinator configured`);
        try {
          return await this.#decideWithHelper(job, space);
        } catch (error) {
          return this.#helperCard(error);
        }
      }),
      ...(this.#options.now ? { now: this.#options.now } : {}),
      ...(this.#options.rolePromptRef ? { rolePromptRef: this.#options.rolePromptRef } : {}),
    });
    this.#projectQueue();
    return this.#executeSpawn(decision, dispatch);
  }

  /**
   * Narrow ticket entry: a human (or its coordinator) names space/title/brief and the
   * kernel builds the Decision itself. No second LLM round, so a chat turn cannot
   * double-judge; the Decision still goes through `coordinate` for schema + guard checks.
   */
  async createTicket(input: { space?: string; project?: string; title?: string; brief?: string; kind?: string }): Promise<Json> {
    const space = input.space;
    if (typeof space !== "string" || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(space)) throw new Error("invalid space");
    const title = input.title;
    if (typeof title !== "string" || !/^(?![\s-])[^{}\r\n]{1,200}$/.test(title)) throw new Error("invalid title");
    const brief = input.brief;
    if (typeof brief !== "string" || !brief.trim() || brief.length > 200_000) throw new Error("brief must be 1–200000 chars");
    const kind = input.kind ?? "build";
    if (kind !== "build" && kind !== "review") throw new Error("kind must be build or review");
    const project = input.project;
    if (project !== undefined && (typeof project !== "string" || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(project))) throw new Error("invalid project");
    this.#projectFolder(space, project);

    const at = (this.#options.now ?? (() => new Date()))().toISOString();
    const id = ledgerId("ev");
    const directory = join(this.stateDir, "tickets");
    mkdirSync(directory, { recursive: true });
    const dataRef = join(directory, `${id}.md`);
    writeFileSync(dataRef, brief, { mode: 0o600 });
    const event = {
      id, source: "im", key: `human:ticket:${id}`, type: "human.ticket_requested",
      object: { kind: "none", id }, title,
      data_ref: dataRef, data_digest: `sha256:${createHash("sha256").update(brief).digest("hex")}`,
      hops: 0, received_at: at,
      merge: { lane_key: `coordinator:none:${id}`, object_key: `none:${id}`, first_seen_at: at, occurrences: 1 },
      space_candidates: [space],
    };
    const dispatch: Dispatch = { kind: "coordinator", laneKey: event.merge.lane_key, space, event };
    const briefRef = join(this.stateDir, "briefs", `${event.id}.md`);
    const decision = await coordinate(dispatch, {
      ledger: this.ledger, ruleset: this.#options.ruleset, stream: "chat_turn",
      policy: this.#policy(space),
      onDecision: () => this.#projectQueue(),
      spaceNote: `新建 ticket：${title}`,
      decide: () => ({
        state: "open",
        why: `新建 ticket：${title}`.slice(0, 140),
        actions: [{
          kind: "spawn_task", risk_tags: [],
          spawn: {
            title, brief_ref: briefRef, base: "current", review: true, merge: false,
            access: kind === "review" ? "read" : "edit", tells: "needed",
          },
        }],
        run: { kind },
        ...(project ? { project } : {}),
      }),
      ...(this.#options.now ? { now: this.#options.now } : {}),
      ...(this.#options.rolePromptRef ? { rolePromptRef: this.#options.rolePromptRef } : {}),
    });
    this.#projectQueue();
    const executed = await this.#executeSpawn(decision, dispatch);
    return { decision_id: executed.id, ticket_ref: executed.run?.task_ref ?? null };
  }

  /**
   * Repair entry: a `collie-task` exists but has no Decision (the coordinator used the task
   * CLI directly). Create a Decision that links it, with no spawn action, so Inbox/Ticket can
   * project the existing Work without duplicating it.
   */
  async adoptTicket(input: { space?: string; task_ref?: string; title?: string; brief?: string; kind?: string }): Promise<Json> {
    const space = input.space;
    if (typeof space !== "string" || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(space)) throw new Error("invalid space");
    const taskRef = input.task_ref;
    if (typeof taskRef !== "string" || !taskRef.trim() || taskRef.length > 240) throw new Error("invalid task_ref");
    const title = input.title;
    if (typeof title !== "string" || !/^(?![\s-])[^{}\r\n]{1,200}$/.test(title)) throw new Error("invalid title");
    const kind = input.kind ?? "build";
    if (kind !== "build" && kind !== "review") throw new Error("kind must be build or review");
    const existing = this.ledger.decisions.find((decision) => decision.run?.task_ref === taskRef && decision.state !== "settled");
    if (existing) return { decision_id: existing.id, ticket_ref: taskRef, adopted: false };

    const brief = typeof input.brief === "string" && input.brief.trim() ? input.brief.slice(0, 200_000) : `# ${title}\n\nAdopted existing task ${taskRef}.`;
    const at = (this.#options.now ?? (() => new Date()))().toISOString();
    const id = ledgerId("ev");
    const directory = join(this.stateDir, "tickets");
    mkdirSync(directory, { recursive: true });
    const dataRef = join(directory, `${id}.md`);
    writeFileSync(dataRef, brief, { mode: 0o600 });
    const event = {
      id, source: "im", key: `human:ticket:adopt:${id}`, type: "human.ticket_requested",
      object: { kind: "none", id }, title,
      data_ref: dataRef, data_digest: `sha256:${createHash("sha256").update(brief).digest("hex")}`,
      hops: 0, received_at: at,
      merge: { lane_key: `coordinator:none:${id}`, object_key: `none:${id}`, first_seen_at: at, occurrences: 1 },
      space_candidates: [space],
    };
    const dispatch: Dispatch = { kind: "coordinator", laneKey: event.merge.lane_key, space, event };
    const decision = await coordinate(dispatch, {
      ledger: this.ledger, ruleset: this.#options.ruleset, stream: "chat_turn",
      policy: this.#policy(space),
      onDecision: () => this.#projectQueue(),
      spaceNote: `接入已有 task：${title}`,
      decide: () => ({
        state: "open",
        why: `接入已有 task：${title}`.slice(0, 140),
        actions: [],
        run: { task_ref: taskRef, kind },
      }),
      ...(this.#options.now ? { now: this.#options.now } : {}),
      ...(this.#options.rolePromptRef ? { rolePromptRef: this.#options.rolePromptRef } : {}),
    });
    this.#projectQueue();
    return { decision_id: decision.id, ticket_ref: taskRef, adopted: true };
  }

  /** The helper is the only ingress session: jobs go to one persistent terminal, never a fresh CLI. */
  async #decideWithHelper(job: Json, space: string): Promise<Json> {
    const config = coordinatorConfig(this.#coordinatorSettings(), space);
    const folder = this.#options.workspaces?.[space]?.folder;
    const result = await enqueueHelperJob(space, () => runHelperJob(job, {
      stateDir: this.stateDir,
      space,
      ...(folder ? { folder } : {}),
      config,
      rolePromptRef: this.#options.rolePromptRef
        ?? join(homedir(), ".config", "herdr-core", "templates", "collie-coordinator.md"),
      ...(this.#options.helper?.run ? { run: this.#options.helper.run } : {}),
      ...(this.#options.helper?.timeoutMs ? { timeoutMs: this.#options.helper.timeoutMs } : {}),
      ...(this.#options.helper?.pollIntervalMs ? { pollIntervalMs: this.#options.helper.pollIntervalMs } : {}),
      bootWaitMs: this.#options.helper?.bootWaitMs ?? 10_000,
      ...(this.#options.now ? { now: this.#options.now } : {}),
    }));
    return { ...result.decision, run: { ...result.decision.run, coordinator_ref: result.address } };
  }

  /** Eagerly keep one helper per live Coordinator, so a restart doesn't wait for ingress. */
  async ensureHelpers(): Promise<Json[]> {
    if (!this.#options.coordinator) return [];
    const run = this.#options.helper?.run ?? defaultHelperRunner;
    const results = [];
    for (const coordinator of await listCoordinators(run)) {
      try {
        const config = coordinatorConfig(this.#coordinatorSettings(), coordinator.space);
        const folder = coordinator.cwd ?? this.#options.workspaces?.[coordinator.space]?.folder;
        results.push(await enqueueHelperJob(coordinator.space, () => ensureHelper({
          stateDir: this.stateDir,
          space: coordinator.space,
          ...(folder ? { folder } : {}),
          config,
          rolePromptRef: this.#options.rolePromptRef
            ?? join(homedir(), ".config", "herdr-core", "templates", "collie-coordinator.md"),
          run,
          coordinatorAddress: coordinator.address,
          coordinatorTab: coordinator.tab,
          bootWaitMs: this.#options.helper?.bootWaitMs ?? 10_000,
          ...(this.#options.now ? { now: this.#options.now } : {}),
        })));
      } catch (error) {
        results.push({ space: coordinator.space, error: String(error instanceof Error ? error.message : error) });
      }
    }
    return results;
  }

  #helperCard(error: unknown): Json {
    const at = (this.#options.now ?? (() => new Date()))().toISOString();
    const reason = String(error instanceof Error ? error.message : error)
      .replace(/\s+/g, " ").trim().slice(0, 110) || "unknown error";
    const question = `Coordinator helper 未就绪：${reason}`.slice(0, 200);
    return {
      state: "waiting", why: `Coordinator helper 未就绪：${reason}`.slice(0, 140),
      actions: [{ kind: "ask", risk_tags: [], ask: { kind: "question", question, options: ["accept", "later", "drop"] } }],
      card: { kind: "question", question, options: ["accept", "later", "drop"], state: "open", created_at: at, acked_at: null, answer: null, snooze_until: null, closed_at: null },
    };
  }

  async #dispatch(dispatch: Dispatch): Promise<Json> {
    if (dispatch.kind === "record_only") return this.#recordOnly(dispatch);
    if (dispatch.kind === "coordinator") {
      const decide = this.#options.decide ?? (async (job: Json) => {
        if (this.#options.coordinator) {
          try {
            return await this.#decideWithHelper(job, job.space.primary);
          } catch (error) {
            return this.#helperCard(error);
          }
        }
        const at = new Date().toISOString();
        return {
          state: "waiting", why: "没有配置 coordinator 执行器，交人判断",
          actions: [{ kind: "ask", risk_tags: [], ask: { kind: "question", question: "这条事件需要怎么处理？", options: ["accept", "later", "drop"] } }],
          card: { kind: "question", question: "这条事件需要怎么处理？", options: ["accept", "later", "drop"], state: "open", created_at: at, acked_at: null, answer: null, snooze_until: null, closed_at: null },
        };
      });
      const decision = await coordinate(dispatch, {
        ledger: this.ledger, ruleset: this.#options.ruleset, decide,
        policy: this.#policy(dispatch.space ?? ""),
        onDecision: () => this.#projectQueue(),
        ...(this.#options.now ? { now: this.#options.now } : {}),
        ...(this.#options.rolePromptRef ? { rolePromptRef: this.#options.rolePromptRef } : {}),
      });
      this.ingress.bindDecision(dispatch.laneKey, decision.id);
      this.#projectIngress();
      return this.#executeSpawn(decision, dispatch);
    }
    throw new Error(`unsupported dispatch kind: ${(dispatch as Json).kind}`);
  }

  #recordOnly(dispatch: Dispatch): Json {
    const at = (this.#options.now ?? (() => new Date()))().toISOString();
    const event = dispatch.event;
    const decision = {
      id: ledgerId("dc"), key: `${event.source}:${event.key}`, space: dispatch.space,
      space_candidates: event.space_candidates ?? [dispatch.space], event_ref: event.id, case_ref: null,
      state: "waiting", why: `hops ${event.hops} 超过上限，只记录不再派发`, decided_by: "system", decided_at: at,
      occurrence: { object_key: event.merge.object_key, kind: event.object.kind, round: 1, hops: event.hops },
      actions: [{ kind: "ask", risk_tags: [], ask: { kind: "alert", question: "委派跳数已熔断，请检查这条链", options: ["drop"] } }],
      risk: { tags: [], forced_waiting: false }, run: { claimed_until: null, unknown_policy: "normal", task_ref: null, coordinator_ref: null },
      human_boundary: { form: "card", chat_injection: false }, priority: null, hold: null,
      card: { kind: "alert", question: "委派跳数已熔断，请检查这条链", options: ["drop"], state: "open", created_at: at, acked_at: null, answer: null, snooze_until: null, closed_at: null },
      receipt_ref: null, proposal: null, ack: null, settled: null,
    };
    return this.ledger.append("decision", decision);
  }

  async answerCard(decisionId: string, answer: Json, coordinatorAddress?: string, run?: ChannelRunner): Promise<Json> {
    const decision = this.ledger.decisions.find((item) => item.id === decisionId);
    if (!decision) throw new Error(`unknown decision: ${decisionId}`);
    return answerHerdrCard(decision, answer, coordinatorAddress, {
      ...(run ? { run } : {}),
      beforeResume: (answered) => {
        this.ledger.append("decision", answered);
        if (answered.state === "settled") {
          const laneKey = this.ingress.laneForDecision(decisionId);
          if (laneKey) this.ingress.completeLane(laneKey);
          this.#projectIngress();
        }
        this.#projectQueue();
      },
    });
  }

  async deliver(decisionId: string): Promise<Json> {
    const decision = this.ledger.decisions.find((item) => item.id === decisionId);
    if (!decision) throw new Error(`unknown decision: ${decisionId}`);
    const actions = decision.actions.filter((action: Json) => action.kind === "emit_command");
    if (actions.length !== 1) throw new Error(`expected one emit_command, got ${actions.length}`);
    const target = actions[0].egress.target;
    const deliver = { gitlab: deliverGitlab, github: deliverGithub, im: deliverIm }[target];
    if (!deliver) throw new Error(`unsupported delivery target: ${target}`);
    await deliver(decision, { ...(this.#options.delivery?.[target] ? { run: this.#options.delivery[target] } : {}) });
    const at = (this.#options.now ?? (() => new Date()))().toISOString();
    const outcome = { merge: "merged", comment: "commented", close: "dropped", notify: "commented" }[actions[0].egress.op];
    const next = {
      ...decision, state: "settled",
      human_boundary: { form: "none", chat_injection: false },
      settled: { at, by: "coordinator", outcome },
    };
    const saved = this.ledger.append("decision", next);
    const laneKey = this.ingress.laneForDecision(decisionId);
    if (laneKey) this.ingress.completeLane(laneKey);
    this.#projectIngress();
    this.#projectQueue();
    return saved;
  }

  acceptReceipt(decisionId: string, receipt: Json): Json {
    const decision = this.ledger.decisions.find((item) => item.id === decisionId);
    if (!decision) throw new Error(`unknown decision: ${decisionId}`);
    const receiptDir = join(this.stateDir, "receipts");
    mkdirSync(receiptDir, { recursive: true });
    writeFileSync(join(receiptDir, `${receipt.id}.json`), JSON.stringify(receipt), { mode: 0o600 });
    this.ledger.append("receipt", receipt);
    const at = receipt.received_at;
    const waiting = !receipt.risk.auto_accept;
    const next = {
      ...decision,
      state: waiting ? "waiting" : "settled",
      receipt_ref: receipt.id,
      human_boundary: { form: waiting ? "card" : "none", chat_injection: false },
      card: waiting ? {
        kind: "accept", question: "任务已 ready，要接受这次交付吗？", options: ["accept", "rework"],
        state: "open", created_at: at, acked_at: null, answer: null, snooze_until: null, closed_at: null,
      } : null,
      settled: waiting ? null : { at, by: "coordinator", outcome: "accepted" },
    };
    const saved = this.ledger.append("decision", next);
    const laneKey = this.ingress.laneForDecision(decisionId);
    if (laneKey) this.ingress.completeLane(laneKey);
    this.#projectIngress();
    this.#projectQueue();
    return saved;
  }

  /** Optional directory intake; source adapters write one immutable Event JSON per file. */
  async drain(directory: string): Promise<Json[]> {
    mkdirSync(directory, { recursive: true });
    const decisions = [];
    for (const name of readdirSync(directory).filter((name) => name.endsWith(".json")).sort()) {
      const path = join(directory, name);
      decisions.push(...await this.process(JSON.parse(readFileSync(path, "utf8"))));
      renameSync(path, `${path}.done`);
    }
    return decisions;
  }
}

if (import.meta.main) {
  const stateDir = process.env.HERDR_INBOX_STATE ?? join(homedir(), ".local", "state", "collie");
  const rulesetPath = process.env.HERDR_INBOX_RULESET ?? join(stateDir, "ruleset.json");
  const configDir = join(homedir(), ".config", "collie");
  const workspacesPath = join(configDir, "workspaces.json");
  const coordinatorPath = join(configDir, "coordinator.json");
  const service = new CollieService({
    stateDir,
    configDir,
    ruleset: JSON.parse(readFileSync(rulesetPath, "utf8")),
    rolePromptRef: join(homedir(), ".config", "herdr-core", "templates", "collie-coordinator.md"),
    ...(existsSync(workspacesPath) ? { workspaces: JSON.parse(readFileSync(workspacesPath, "utf8")) } : {}),
    coordinator: { settingsPath: coordinatorPath },
  });
  const socketPath = join(stateDir, "service.sock");
  if (existsSync(socketPath)) unlinkSync(socketPath);
  startAnswerServer(service, socketPath);
  const ingressPort = Number(process.env.COLLIE_INGRESS_PORT ?? 0);
  if (Number.isInteger(ingressPort) && ingressPort > 0) {
    startIngressServer(service, ingressPort, process.env.COLLIE_INGRESS_HOST ?? "127.0.0.1");
    console.error(`collie ingress listening on ${process.env.COLLIE_INGRESS_HOST ?? "127.0.0.1"}:${ingressPort}`);
  }
  const incoming = join(stateDir, "incoming");
  let draining = false;
  const drain = async () => {
    if (draining) return;
    draining = true;
    try { await service.drain(incoming); }
    catch (error) { console.error("collie intake failed:", error instanceof Error ? error.message : error); }
    finally { draining = false; }
  };
  await drain();
  let ensuring = false;
  const ensure = async () => {
    if (ensuring) return;
    ensuring = true;
    try { await service.ensureHelpers(); }
    catch (error) { console.error("collie helper ensure failed:", error instanceof Error ? error.message : error); }
    finally { ensuring = false; }
  };
  await ensure();
  setInterval(ensure, 30_000);
  setInterval(drain, 1000);
  console.error(`collie service ready: ${incoming}`);
}
