import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { Ingress, type Dispatch } from "../kernel/ingress.ts";
import { Ledger, ledgerId } from "../kernel/ledger.ts";
import { humanMessage } from "../kernel/message.ts";
import { coordinate, recordOnlyDecision, type CoordinateOptions } from "../kernel/coordinator.ts";
import { renderBrief } from "../kernel/brief.ts";
import { runHerdrTask, waitForHerdrReceipt, runningHerdrTasks, defaultHerdrRunner, type HerdrAgentOptions } from "../plugins/agent/herdr.ts";
import { answerHerdrCard, type ChannelRunner } from "../plugins/channel/herdr.ts";
import { deliverGitlab } from "../plugins/delivery/gitlab.ts";
import { deliverGithub } from "../plugins/delivery/github.ts";
import { deliverIm } from "../plugins/delivery/im.ts";
import type { DeliveryRunner } from "../plugins/delivery/common.ts";
import { startAnswerServer, startIngressServer } from "./answer-server.ts";
import { CollaborationRegistry } from "./collaboration.ts";
import { coordinatorConfig } from "../plugins/agent/coordinator.ts";
import { defaultHelperRunner, enqueueHelperJob, ensureHelper, listCoordinators, runHelperJob, validateProposal, type HelperRunner } from "../plugins/agent/helper.ts";
import { createHash } from "node:crypto";
import { settle } from "../protocol/invariants.mjs";

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
  coordinator?: { settings?: Json; settingsPath?: string };
  helper?: { run?: HelperRunner; timeoutMs?: number; pollIntervalMs?: number; bootWaitMs?: number };
  collaboration?: CollaborationRegistry;
  settingsPath?: string;
}

export class CollieService {
  readonly ledger: Ledger;
  readonly ingress: Ingress;
  readonly stateDir: string;
  readonly configDir: string;
  readonly collaboration: CollaborationRegistry;
  readonly #options: CollieServiceOptions;

  constructor(options: CollieServiceOptions) {
    this.#options = options;
    this.stateDir = resolve(options.stateDir);
    this.configDir = resolve(options.configDir ?? join(homedir(), ".config", "collie"));
    this.collaboration = options.collaboration ?? new CollaborationRegistry(this.configDir);
    mkdirSync(this.stateDir, { recursive: true });
    mkdirSync(this.configDir, { recursive: true });
    this.ledger = Ledger.open(join(this.stateDir, "ledger.json"));
    // queue.json is a projection, not an independent state file. Restore it on boot so a
    // deleted/stale projection never leaves the Inbox empty while the Ledger still has work.
    this.#projectQueue();
    this.ingress = new Ingress();
    const snapshotPath = join(this.stateDir, "ingress.json");
    if (existsSync(snapshotPath)) this.ingress.restore(JSON.parse(readFileSync(snapshotPath, "utf8")));
  }

  /** Settings writes role/playbook files, then asks the running service to read them again. */
  reloadCollaboration(): Json {
    this.collaboration.reload();
    return this.collaboration.snapshot();
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
    if (!workspace?.folder) throw new Error(`no driver workspace configured for space ${space}`);
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

  #taskSettings(): Json {
    const path = this.#options.settingsPath ?? join(this.configDir, "settings.json");
    try {
      const settings = JSON.parse(readFileSync(path, "utf8"));
      return settings && typeof settings === "object" ? settings : {};
    } catch { return {}; }
  }

  #roleProfile(role: string, settings = this.#taskSettings()): Json {
    return settings?.[role] && typeof settings[role] === "object" ? settings[role] : {};
  }

  #coordinatorPrompt(): string {
    const prompt = this.#options.rolePromptRef ?? this.collaboration.roles.get("coordinator")?.prompt;
    if (!prompt) throw new Error("coordinator role prompt is not installed");
    return prompt;
  }

  async #coordinate(dispatch: Dispatch, options: CoordinateOptions): Promise<Json> {
    const running = await runningHerdrTasks(dispatch.space, {
      ...(this.#options.agent?.run ? { run: this.#options.agent.run } : {}),
      ...(this.#options.now ? { now: this.#options.now } : {}),
    });
    return coordinate(dispatch, { rolePromptRef: this.#coordinatorPrompt(), ...options, running });
  }

  #agentOptions(decision: Json): HerdrAgentOptions {
    return {
      ...this.#options.agent,
      onSpawn: async (task) => {
        const latest = this.ledger.decisions.find((item) => item.id === decision.id) ?? decision;
        this.ledger.append("decision", { ...latest, state: "open", run: { ...latest.run, task_ref: task.ref } });
        this.#projectQueue();
        await this.#options.agent?.onSpawn?.(task);
      },
    };
  }

  async #executeSpawn(decision: Json, dispatch: Dispatch): Promise<Json> {
    const spawns = decision.actions.filter((action: Json) => action.kind === "spawn_task");
    if (decision.state !== "open" || !spawns.length) return decision;
    if (spawns.length !== 1) throw new Error("M1 executes exactly one spawn_task per decision");
    const workspace = this.#options.workspaces?.[decision.space];
    if (!workspace) throw new Error(`no driver workspace configured for space ${decision.space}`);
    const folder = this.#projectFolder(decision.space, decision.project);
    const playbook = decision.playbook?.name ? this.collaboration.playbook(decision.playbook.name) : null;
    const driver = this.collaboration.roles.get("driver");
    const driverPrompt = driver?.prompt ? readFileSync(driver.prompt, "utf8") : undefined;
    // The kernel renders the trusted brief; the coordinator only points at data.
    const roleSettings = this.#taskSettings();
    const roleCatalog = this.collaboration.roleCatalog();
    for (const role of roleCatalog.roles) {
      const runner = this.#roleProfile(role.name, roleSettings);
      if (Object.keys(runner).length) (role as Json).runner = runner;
    }
    const skillPath = join(this.configDir, "skills", "cli", "SKILL.md");
    const cliSkill = existsSync(skillPath) ? readFileSync(skillPath, "utf8") : undefined;
    const brief = renderBrief(dispatch, join(this.stateDir, "briefs"), playbook ?? undefined, driverPrompt, roleCatalog, cliSkill);
    const executed = {
      ...decision,
      actions: decision.actions.map((action: Json) => action.kind === "spawn_task"
        ? { ...action, spawn: { ...action.spawn, brief_ref: brief } }
        : action),
    };
    this.ledger.append("decision", executed);
    this.#projectQueue();
    decision = executed;
    const driverProfile = this.#roleProfile("driver", roleSettings);
    const rule = {
      to: {
        kind: "herdr_task", space: decision.space,
        ...(decision.project ? { project: decision.project } : {}),
        ...(playbook ? { playbook: { name: playbook.name, version: playbook.version } } : {}),
        cwd: { path: folder, kind: "git" },
      },
      agent: {
        ...(driverProfile.agent || workspace.cli ? { cli: driverProfile.agent ?? workspace.cli } : {}),
        ...(driverProfile.model && driverProfile.model !== "default" ? { model: driverProfile.model } : {}),
        ...(driverProfile.effort ? { effort: driverProfile.effort } : {}),
      },
    };
    try {
      const receipt = await runHerdrTask(decision, rule, this.#agentOptions(decision));
      return await this.acceptReceipt(decision.id, receipt);
    } catch (error) {
      const latest = this.ledger.decisions.find((item) => item.id === decision.id) ?? decision;
      return this.#taskFailure(latest, error);
    }
  }

  /**
   * Narrow ticket entry: a human (or its coordinator) names space/title/brief and the
   * kernel builds the Decision itself. No second LLM round, so a human message cannot
   * double-judge; the Decision still goes through `coordinate` for schema + guard checks.
   */
  async createTicket(input: { space?: string; project?: string; title?: string; brief?: string; kind?: string; playbook?: string }): Promise<Json> {
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
    const projectFolder = this.#projectFolder(space, project);
    const playbook = this.collaboration.playbook(input.playbook ?? this.collaboration.defaultPlaybook(kind));

    const at = (this.#options.now ?? (() => new Date()))().toISOString();
    const id = ledgerId("msg");
    const directory = join(this.stateDir, "tickets");
    mkdirSync(directory, { recursive: true });
    const dataRef = join(directory, `${id}.md`);
    writeFileSync(dataRef, brief, { mode: 0o600 });
    const message = humanMessage({
      id, space, key: `human:ticket:${id}`, type: "human.ticket_requested", title,
      dataRef: dataRef, dataDigest: `sha256:${createHash("sha256").update(brief).digest("hex")}`, at,
      ...(project ? { project } : {}),
    });
    this.ledger.append("message", message);
    const dispatch: Dispatch = { kind: "coordinator", laneKey: message.merge.lane_key, space, message };
    const briefRef = join(this.stateDir, "briefs", `${message.id}.md`);
    const decision = await this.#coordinate(dispatch, {
      ledger: this.ledger, ruleset: this.#options.ruleset, catalog: this.collaboration.catalog(),
      origin: "human", decided_by: "human", policy: this.#policy(space),
      onDecision: () => this.#projectQueue(),
      spaceNote: `新建 ticket：${title}`,
      decide: () => ({
        state: "open",
        why: `新建 ticket：${title}`.slice(0, 140),
        actions: [{
          kind: "spawn_task", risk_tags: [],
          spawn: {
            title, brief_ref: briefRef, base: "current",
            access: kind === "review" ? "read" : "edit",
          },
        }],
        run: { kind },
        origin: "human",
        playbook: { name: playbook.name, version: playbook.version },
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
   * Coordinator chat commits the Decision it produced. This is the chat counterpart of the
   * helper's Decision JSON: one CoordinatorTurn/Case, one Decision contract. Explicit human
   * commands (ticket.create) stay a separate `decided_by=human` path.
   */
  async commitDecision(input: { space?: string; project?: string; decision?: Json; turn_id?: string }): Promise<Json> {
    const space = input.space;
    if (typeof space !== "string" || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(space)) throw new Error("invalid space");
    const decision = input.decision;
    if (!decision || typeof decision !== "object" || Array.isArray(decision)) throw new Error("decision must be an object");
    const project = input.project ?? decision.project;
    if (project !== undefined && (typeof project !== "string" || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(project))) throw new Error("invalid project");
    const folder = this.#projectFolder(space, project);
    const playbook = decision.playbook?.name
      ? this.collaboration.playbook(decision.playbook.name)
      : decision.run?.kind === "review" ? this.collaboration.playbook("review") : this.collaboration.playbook("feature");

    const at = (this.#options.now ?? (() => new Date()))().toISOString();
    const turnKey = `human:turn:${input.turn_id ?? decision.key ?? "untracked"}`;
    const existing = this.ledger.decisions.find((item) => item.key === turnKey);
    if (existing) return existing;
    const id = ledgerId("msg");
    const directory = join(this.stateDir, "turns");
    mkdirSync(directory, { recursive: true });
    const dataRef = join(directory, `${id}.json`);
    const body = JSON.stringify({ origin: "human", decision });
    writeFileSync(dataRef, body, { mode: 0o600 });
    const message = humanMessage({
      id, space, key: turnKey, type: "human.turn",
      title: String(decision.why ?? "human turn").slice(0, 80),
      dataRef: dataRef, dataDigest: `sha256:${createHash("sha256").update(body).digest("hex")}`, at,
      ...(project ? { project } : {}),
    });
    this.ledger.append("message", message);
    const dispatch: Dispatch = { kind: "coordinator", laneKey: message.merge.lane_key, space, message };
    const result = await this.#coordinate(dispatch, {
      ledger: this.ledger, ruleset: this.#options.ruleset, catalog: this.collaboration.catalog(),
      origin: "human", decided_by: "coordinator",
      playbook: { name: playbook.name, version: playbook.version },
      policy: this.#policy(space),
      onDecision: () => this.#projectQueue(),
      spaceNote: `Coordinator chat：${String(decision.why ?? "").slice(0, 80)}`,
      decide: () => ({
        ...decision,
        origin: "human",
        playbook: { name: playbook.name, version: playbook.version },
        ...(project ? { project } : {}),
      }),
      ...(this.#options.now ? { now: this.#options.now } : {}),
      ...(this.#options.rolePromptRef ? { rolePromptRef: this.#options.rolePromptRef } : {}),
    });
    this.#projectQueue();
    return this.#executeSpawn(result, dispatch);
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
    const id = ledgerId("msg");
    const directory = join(this.stateDir, "tickets");
    mkdirSync(directory, { recursive: true });
    const dataRef = join(directory, `${id}.md`);
    writeFileSync(dataRef, brief, { mode: 0o600 });
    const message = humanMessage({
      id, space, key: `human:ticket:adopt:${id}`, type: "human.ticket_requested", title,
      dataRef: dataRef, dataDigest: `sha256:${createHash("sha256").update(brief).digest("hex")}`, at,
    });
    this.ledger.append("message", message);
    const dispatch: Dispatch = { kind: "coordinator", laneKey: message.merge.lane_key, space, message };
    const decision = await this.#coordinate(dispatch, {
      ledger: this.ledger, ruleset: this.#options.ruleset, catalog: this.collaboration.catalog(),
      origin: "human", decided_by: "human", policy: this.#policy(space),
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
      rolePromptRef: this.#coordinatorPrompt(),
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
          rolePromptRef: this.#coordinatorPrompt(),
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

  /** Recover helper jobs whose service waiters died with a restart. */
  async recoverHelperJobs(): Promise<Json[]> {
    const root = join(this.stateDir, "helper");
    const recovered: Json[] = [];
    if (!existsSync(root)) return recovered;
    for (const space of readdirSync(root, { withFileTypes: true })) {
      if (!space.isDirectory()) continue;
      const jobs = join(root, space.name, "jobs");
      if (!existsSync(jobs)) continue;
      for (const name of readdirSync(jobs).filter((name) => name.endsWith(".json")).sort()) {
        const path = join(jobs, name);
        const doc = JSON.parse(readFileSync(path, "utf8"));
        const caseRef = doc?.job?.id;
        const decision = this.ledger.decisions.find((item) => item.case_ref === caseRef && item.state === "open");
        if (!decision || this.ledger.history("decision").filter((item) => item.id === decision.id).length !== 1) continue;
        const at = (this.#options.now ?? (() => new Date()))().toISOString();
        let proposal: Json | null = null;
        let failure: unknown = null;
        const output = doc?.instruction?.output_path;
        if (typeof output === "string" && existsSync(output)) {
          try { proposal = validateProposal(JSON.parse(readFileSync(output, "utf8")), { space: space.name, at }); }
          catch (error) { failure = error; }
        }
        if (proposal) {
          try {
            const caseMessage = doc.job.message;
            const message = {
              ...caseMessage,
              id: caseMessage.ref,
              space_candidates: doc.job.space?.candidates ?? [space.name],
              merge: {
                lane_key: caseMessage.lane_key,
                object_key: caseMessage.object_key,
                occurrences: caseMessage.occurrences ?? 1,
              },
            };
            const dispatch: Dispatch = { kind: "coordinator", laneKey: message.merge.lane_key, space: space.name, message };
            const saved = await this.#coordinate(dispatch, {
              ledger: this.ledger, ruleset: this.#options.ruleset, catalog: this.collaboration.catalog(),
              decide: () => proposal!, decisionId: decision.id, origin: decision.origin, policy: this.#policy(space.name),
              onDecision: () => this.#projectQueue(),
              ...(decision.receipt_ref ? { beforeCommit: (candidate: Json) => this.#beforeReceiptCommit(decision, candidate) } : {}),
              ...(this.#options.now ? { now: this.#options.now } : {}),
            });
            let completed: Json;
            if (decision.receipt_ref) {
              completed = saved.state === "open" ? await this.#watchRework(saved) : saved;
              const laneKey = this.ingress.laneForDecision(decision.id);
              if (laneKey) this.ingress.completeLane(laneKey);
              this.#projectIngress();
            } else {
              completed = await this.#executeSpawn(saved, dispatch);
            }
            recovered.push(completed);
            continue;
          } catch (error) { failure = error; }
        }
        const latest = this.ledger.decisions.find((item) => item.id === decision.id);
        if (!latest || latest.state !== "open" || this.ledger.history("decision").filter((item) => item.id === decision.id).length !== 1) continue;
        const detail = failure ? `：${String(failure instanceof Error ? failure.message : failure).replace(/\s+/g, " ").slice(0, 80)}` : "";
        const question = `Coordinator helper job 在 service 重启前未返回有效结果（${doc.id ?? name}）${detail}；请决定是否重试`.slice(0, 200);
        const next = {
          ...latest,
          state: "waiting",
          why: question.slice(0, 140),
          human_boundary: { form: "card", chat_injection: false },
          actions: [{ kind: "ask", risk_tags: [], ask: { kind: "alert", question, options: ["accept", "drop"] } }],
          card: { kind: "alert", question, options: ["accept", "drop"], state: "open", created_at: at,
            acked_at: null, answer: null, snooze_until: null, closed_at: null },
        };
        recovered.push(this.ledger.append("decision", next));
      }
    }
    if (recovered.length) this.#projectQueue();
    return recovered;
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
      const candidates = dispatch.message?.space_candidates ?? [];
      const decide = candidates.length > 1
        ? () => {
          const at = (this.#options.now ?? (() => new Date()))().toISOString();
          const question = `这条消息属于多个 space（${candidates.join(" / ")}），请选择 primary`;
          return {
            state: "waiting", why: question.slice(0, 140),
            actions: [{ kind: "ask", risk_tags: [], ask: { kind: "question", question, options: ["accept", "drop"] } }],
            card: { kind: "question", question, options: ["accept", "drop"], state: "open", created_at: at,
              acked_at: null, answer: null, snooze_until: null, closed_at: null },
          };
        }
        : this.#options.decide ?? (async (job: Json) => {
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
      const decision = await this.#coordinate(dispatch, {
        ledger: this.ledger, ruleset: this.#options.ruleset, catalog: this.collaboration.catalog(), decide, origin: "event",
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
    return this.ledger.append("decision", recordOnlyDecision(dispatch, (this.#options.now ?? (() => new Date()))().toISOString()));
  }

  async #taskFolder(decision: Json): Promise<string> {
    try {
      return this.#projectFolder(decision.space, decision.project);
    } catch (error) {
      const taskRef = decision.run?.task_ref;
      if (typeof taskRef !== "string" || !taskRef) throw error;
      const view = await (this.#options.agent?.run ?? defaultHerdrRunner)(["show", taskRef, "--json"]);
      if (typeof view.folder !== "string" || !view.folder) throw error;
      return view.folder;
    }
  }

  async #taskCommand(decision: Json, command: "accept" | "done" | "start", doneBy?: "coordinator" | "human"): Promise<Json> {
    const taskRef = decision.run?.task_ref;
    if (typeof taskRef !== "string" || !taskRef) throw new Error("task finalization requires Decision.run.task_ref");
    const folder = await this.#taskFolder(decision);
    const args = [command, taskRef, "--folder", folder,
      ...(command === "start" ? ["--space", decision.space] : []), "--json"];
    if (doneBy) args.push("--done-by", doneBy);
    return (this.#options.agent?.run ?? defaultHerdrRunner)(args);
  }

  async #watchRework(decision: Json): Promise<Json> {
    const taskRef = decision.run?.task_ref;
    if (typeof taskRef !== "string" || !taskRef) throw new Error("rework requires Decision.run.task_ref");
    const folder = await this.#taskFolder(decision);
    const receipt = await waitForHerdrReceipt({
      ref: taskRef, folder, space: decision.space,
      ...(decision.project ? { project: decision.project } : {}),
      previousState: decision.receipt_ref ? "ready" : "running",
    }, decision, this.#options.agent);
    return this.acceptReceipt(decision.id, receipt);
  }

  #terminalDecision(decision: Json, at: string, by: "coordinator" | "human", outcome: string): Json {
    return { ...settle(decision, { at, by, outcome }), human_boundary: { form: "none", chat_injection: false } };
  }

  #commitDecision(decision: Json): Json {
    const saved = this.ledger.append("decision", decision);
    if (saved.state === "settled") {
      const laneKey = this.ingress.laneForDecision(saved.id);
      if (laneKey) this.ingress.completeLane(laneKey);
      this.#projectIngress();
    }
    this.#projectQueue();
    return saved;
  }

  async #finalizeAnswer(decision: Json, answered: Json, answer: Json): Promise<Json> {
    if (!decision.run?.task_ref) return answered;
    if (answer.option === "drop") {
      await this.#taskCommand(decision, "done", "human");
      return this.#terminalDecision(answered, answer.at, "human", "dropped");
    }
    if (answer.option === "rework") {
      await this.#taskCommand(decision, "start");
      return answered;
    }
    if (answer.option === "accept" && decision.receipt_ref) {
      await this.#taskCommand(decision, "accept", "human");
      return this.#terminalDecision(answered, answer.at, "human", "accepted");
    }
    return answered;
  }

  async answerCard(decisionId: string, answer: Json, coordinatorAddress?: string, run?: ChannelRunner): Promise<Json> {
    const decision = this.ledger.decisions.find((item) => item.id === decisionId);
    if (!decision) throw new Error(`unknown decision: ${decisionId}`);
    const result = await answerHerdrCard(decision, answer, coordinatorAddress, {
      ...(run ? { run } : {}),
      beforeResume: async (answered) => {
        const finalized = await this.#finalizeAnswer(decision, answered, answer);
        return this.#commitDecision(finalized);
      },
    });
    if (answer.option === "rework" && decision.run?.task_ref) {
      try {
        const reworked = await this.#watchRework(result.decision);
        return { ...result, decision: reworked };
      } catch (error) {
        const latest = this.ledger.decisions.find((item) => item.id === decisionId) ?? result.decision;
        return { ...result, decision: this.#taskFailure(latest, error) };
      }
    }
    // An accepted outbound action is now authorized: execute the same Decision's egress.
    // A Card for a mere question has no emit_command and returns unchanged.
    const latest = this.ledger.decisions.find((item) => item.id === decisionId);
    if (answer.option === "accept" && latest?.state === "open"
      && latest.actions.some((action: Json) => action.kind === "emit_command")) {
      const delivered = await this.deliver(decisionId);
      return { ...result, decision: delivered, delivered: true };
    }
    return result;
  }

  async deliver(decisionId: string): Promise<Json> {
    const decision = this.ledger.decisions.find((item) => item.id === decisionId);
    if (!decision) throw new Error(`unknown decision: ${decisionId}`);
    const actions = decision.actions.filter((action: Json) => action.kind === "emit_command");
    if (actions.length !== 1) throw new Error(`expected one emit_command, got ${actions.length}`);
    if (decision.state === "settled") return decision;
    const target = actions[0].egress.target;
    const deliver = { gitlab: deliverGitlab, github: deliverGithub, im: deliverIm }[target];
    if (!deliver) throw new Error(`unsupported delivery target: ${target}`);
    await deliver(decision, { ...(this.#options.delivery?.[target] ? { run: this.#options.delivery[target] } : {}) });
    const at = (this.#options.now ?? (() => new Date()))().toISOString();
    const outcome = { merge: "merged", comment: "commented", close: "dropped", notify: "commented" }[actions[0].egress.op];
    return this.#commitDecision(this.#terminalDecision(decision, at, "coordinator", outcome));
  }

  #taskFailure(decision: Json, error: unknown): Json {
    const at = (this.#options.now ?? (() => new Date()))().toISOString();
    const reason = String(error instanceof Error ? error.message : error).replace(/\s+/g, " ").trim().slice(0, 180) || "task failed";
    const question = `Task 未交付：${reason}`.slice(0, 200);
    const next = {
      ...decision,
      state: "waiting",
      why: question.slice(0, 140),
      human_boundary: { form: "card", chat_injection: false },
      actions: [{ kind: "ask", risk_tags: [], ask: { kind: "alert", question, options: ["accept", "drop", "rework"] } }],
      card: { kind: "alert", question, options: ["accept", "drop", "rework"], state: "open", created_at: at,
        acked_at: null, answer: null, snooze_until: null, closed_at: null },
    };
    const saved = this.ledger.append("decision", next);
    this.#projectQueue();
    return saved;
  }

  async #beforeReceiptCommit(linked: Json, candidate: Json): Promise<Json> {
    if (candidate.actions.some((action: Json) => action.kind === "spawn_task")) {
      throw new Error("a ready receipt must continue the same task, not spawn another");
    }
    if (candidate.state === "settled") {
      if (candidate.settled.outcome === "accepted") await this.#taskCommand(linked, "accept", "coordinator");
      else if (candidate.settled.outcome === "dropped") await this.#taskCommand(linked, "done", "coordinator");
      else throw new Error(`unsupported ready receipt outcome: ${candidate.settled.outcome}`);
      return this.#terminalDecision(candidate, candidate.settled.at, "coordinator", candidate.settled.outcome);
    }
    if (candidate.state === "open") await this.#taskCommand(linked, "start");
    return candidate;
  }

  async acceptReceipt(decisionId: string, receipt: Json): Promise<Json> {
    const decision = this.ledger.decisions.find((item) => item.id === decisionId);
    if (!decision) throw new Error(`unknown decision: ${decisionId}`);
    if (receipt.decision_ref !== decisionId) throw new Error(`receipt ${receipt.id} belongs to another Decision`);
    const receiptDir = join(this.stateDir, "receipts");
    mkdirSync(receiptDir, { recursive: true });
    const body = JSON.stringify(receipt);
    const receiptPath = join(receiptDir, `${receipt.id}.json`);
    writeFileSync(receiptPath, body, { mode: 0o600 });
    this.ledger.append("receipt", receipt);
    const linked = this.ledger.append("decision", { ...decision, receipt_ref: receipt.id });
    const message = {
      id: ledgerId("msg"), source: "herdr-task", key: receipt.id, type: "task.ready",
      object: { kind: decision.occurrence.kind, id: decision.run.task_ref },
      title: receipt.summary, data_ref: receiptPath,
      data_digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
      hops: decision.occurrence.hops, received_at: receipt.received_at,
      merge: {
        lane_key: `task:${decision.id}`, object_key: decision.occurrence.object_key,
        first_seen_at: receipt.received_at, occurrences: 1,
      },
      space_candidates: [decision.space],
      ...(decision.project ? { project: decision.project } : {}),
    };
    this.ledger.append("message", message);
    const dispatch: Dispatch = { kind: "coordinator", laneKey: message.merge.lane_key, space: decision.space, message };
    const fallback = () => {
      const question = "任务已 ready，要接受这次交付吗？";
      return {
        state: "waiting", why: "等待人验收 ready 交付",
        actions: [{ kind: "ask", risk_tags: [], ask: { kind: "accept", question, options: ["accept", "rework", "drop"] } }],
        card: { kind: "accept", question, options: ["accept", "rework", "drop"], state: "open", created_at: receipt.received_at,
          acked_at: null, answer: null, snooze_until: null, closed_at: null },
      };
    };
    const decide = this.#options.decide ?? (this.#options.coordinator
      ? async (job: Json) => {
        try { return await this.#decideWithHelper(job, decision.space); }
        catch (error) { return this.#helperCard(error); }
      }
      : fallback);
    const saved = await this.#coordinate(dispatch, {
      ledger: this.ledger, ruleset: this.#options.ruleset, catalog: this.collaboration.catalog(), decide,
      decisionId, origin: decision.origin, policy: this.#policy(decision.space),
      onDecision: () => this.#projectQueue(),
      beforeCommit: (candidate) => this.#beforeReceiptCommit(linked, candidate),
      ...(this.#options.now ? { now: this.#options.now } : {}),
      ...(this.#options.rolePromptRef ? { rolePromptRef: this.#options.rolePromptRef } : {}),
    });
    const completed = saved.state === "open" ? await this.#watchRework(saved) : saved;
    const laneKey = this.ingress.laneForDecision(decisionId);
    if (laneKey) this.ingress.completeLane(laneKey);
    this.#projectIngress();
    this.#projectQueue();
    return completed;
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
  await service.recoverHelperJobs();
  setInterval(ensure, 30_000);
  setInterval(drain, 1000);
  console.error(`collie service ready: ${incoming}`);
}
