import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type CollaborationRole = {
  id: string;
  title: string;
  purpose: string;
  duties: string[];
  prohibitions: string[];
  inputs?: string[];
  outputs?: string[];
  modes?: Record<string, { input?: string; output?: string; tools?: string[] }>;
  prompt?: string;
  source?: string;
};

export type PlaybookStage = {
  id: string;
  role: string;
  needs?: string[];
  parallel_with?: string;
  outputs?: string[];
  gate?: string;
};

export type CollaborationPlaybook = {
  id: string;
  title: string;
  version: number;
  when?: string[];
  stages: PlaybookStage[];
  gates?: Array<{ id: string; predicate: string }>;
  allowed_next?: string[];
  requires?: string[];
  discloses?: string[];
  source?: string;
};

const role = (value: CollaborationRole): CollaborationRole => value;

const playbook = (value: CollaborationPlaybook): CollaborationPlaybook => value;

export const BUILTIN_ROLES: Record<string, CollaborationRole> = {
  coordinator: role({
    id: "coordinator", title: "Coordinator", purpose: "把事件和人的意图变成有边界的 Task",
    duties: ["判断事件是否需要行动", "选择 playbook", "生成 Ticket / Task", "处理人的 steering 和 Card"],
    prohibitions: ["不产出交付物", "不做 review / verify", "不直接修改 task 状态", "不替人裁决"],
    modes: {
      event: { input: "event_job", output: "decision" },
      chat: { input: "human_message", output: "decision+reply", tools: ["ticket.create", "ticket.update", "card.answer"] },
    },
    prompt: "templates/collie-coordinator.md", source: "dsx:coordinator",
  }),
  worker: role({
    id: "worker", title: "Worker", purpose: "在 task folder/worktree 内交付实现",
    duties: ["按 brief 实现", "运行定向检查", "提交 commit", "提交 ready receipt"],
    prohibitions: ["不扩大范围", "不替自己验收", "不修改 Ledger"],
    prompt: "templates/collie-worker.md", source: "dsx:worker",
  }),
  reviewer: role({
    id: "reviewer", title: "Reviewer", purpose: "判断改动该不该这样写",
    duties: ["读 diff 与 brief", "按 Spec / Standards / 结构审查", "报告 findings 与 unproven"],
    prohibitions: ["不改代码", "不跑三验", "不裁决合并"],
    prompt: "templates/collie-reviewer.md", source: "dsx:reviewer",
  }),
  verifier: role({
    id: "verifier", title: "Verifier", purpose: "判断改动能不能用",
    duties: ["复跑检查", "实驱真实表面", "给出 verdict 与 evidence"],
    prohibitions: ["不改产品代码", "不替 worker 修", "不裁决合并"],
    prompt: "templates/collie-verifier.md", source: "dsx:verifier",
  }),
  planner: role({
    id: "planner", title: "Planner", purpose: "在实现前给出结构与接口方案",
    duties: ["提出候选设计", "比较 tradeoffs", "写 pass predicate"],
    prohibitions: ["不直接交付实现", "不替 review / verify"],
    source: "dsx:planner",
  }),
  researcher: role({
    id: "researcher", title: "Researcher", purpose: "只读调查并产出有引用的解释",
    duties: ["建立心智模型", "追踪代码与历史", "输出事实与不确定项"],
    prohibitions: ["不改产品代码", "不开 PR"],
    source: "collie:investigation",
  }),
  watcher: role({
    id: "watcher", title: "Watcher", purpose: "观察基础设施、队列和外部状态并报告异常",
    duties: ["观察状态", "发现异常", "产生告警或事件"],
    prohibitions: ["不改产品代码", "不替协调位裁决"],
    source: "dsx:watcher",
  }),
};

export const BUILTIN_PLAYBOOKS: Record<string, CollaborationPlaybook> = {
  feature: playbook({
    id: "feature", title: "Feature", version: 1, source: "dsx:feature",
    when: ["new behavior", "changed behavior", "human build request"],
    requires: ["role:coordinator", "role:worker", "role:reviewer", "role:verifier"],
    discloses: ["reference:review-axes", "reference:three-gates"],
    stages: [
      { id: "explore", role: "coordinator" },
      { id: "design", role: "planner" },
      { id: "implement", role: "worker", needs: ["design"], outputs: ["commit"] },
      { id: "review", role: "reviewer", needs: ["commit"], parallel_with: "verify", gate: "review" },
      { id: "verify", role: "verifier", needs: ["commit"], parallel_with: "review", gate: "verify" },
      { id: "accept", role: "human", needs: ["review", "verify"] },
    ],
    gates: [
      { id: "review", predicate: "no_blocking_findings" },
      { id: "verify", predicate: "verdict_pass" },
    ],
    allowed_next: ["review", "refactoring"],
  }),
  "bug-fix": playbook({
    id: "bug-fix", title: "Bug fix", version: 1, source: "dsx:bug-fix",
    when: ["defect", "regression", "failing check"],
    requires: ["role:coordinator", "role:worker", "role:reviewer", "role:verifier"],
    discloses: ["reference:review-axes", "reference:three-gates"],
    stages: [
      { id: "reproduce", role: "coordinator" },
      { id: "fix", role: "worker", needs: ["reproduce"], outputs: ["commit"] },
      { id: "review", role: "reviewer", needs: ["commit"], parallel_with: "verify", gate: "review" },
      { id: "verify", role: "verifier", needs: ["commit"], parallel_with: "review", gate: "verify" },
      { id: "accept", role: "human", needs: ["review", "verify"] },
    ],
    gates: [
      { id: "review", predicate: "no_blocking_findings" },
      { id: "verify", predicate: "repro_passes" },
    ],
    allowed_next: ["review"],
  }),
  review: playbook({
    id: "review", title: "Review", version: 1, source: "dsx:review",
    when: ["reviewer assigned", "review requested"],
    requires: ["role:reviewer"],
    discloses: ["reference:review-axes"],
    stages: [
      { id: "review", role: "reviewer", gate: "review" },
      { id: "accept", role: "human", needs: ["review"] },
    ],
    gates: [{ id: "review", predicate: "no_blocking_findings" }],
    allowed_next: [],
  }),
  investigation: playbook({
    id: "investigation", title: "Investigation", version: 1, source: "dsx:investigation",
    when: ["read-only question", "design investigation"],
    requires: ["role:researcher"],
    stages: [
      { id: "investigate", role: "researcher" },
      { id: "accept", role: "human", needs: ["investigate"] },
    ],
    allowed_next: [],
  }),
  refactoring: playbook({
    id: "refactoring", title: "Refactoring", version: 1, source: "dsx:refactoring",
    when: ["behavior-preserving change", "rename", "extract", "move"],
    requires: ["role:worker", "role:reviewer", "role:verifier"],
    stages: [
      { id: "test-net", role: "worker" },
      { id: "refactor", role: "worker", needs: ["test-net"], outputs: ["commit"] },
      { id: "review", role: "reviewer", needs: ["commit"], parallel_with: "verify", gate: "review" },
      { id: "verify", role: "verifier", needs: ["commit"], parallel_with: "review", gate: "verify" },
      { id: "accept", role: "human", needs: ["review", "verify"] },
    ],
    gates: [
      { id: "review", predicate: "behavior_unchanged_findings_clear" },
      { id: "verify", predicate: "tests_and_surface_unchanged" },
    ],
    allowed_next: ["review"],
  }),
  prototype: playbook({
    id: "prototype", title: "Prototype", version: 1, source: "dsx:prototype",
    when: ["design decision", "cheap experiment", "are we sure"],
    requires: ["role:worker", "role:verifier"],
    stages: [
      { id: "build", role: "worker" },
      { id: "observe", role: "verifier", needs: ["build"] },
      { id: "decide", role: "human", needs: ["observe"] },
    ],
    allowed_next: ["feature", "refactoring"],
  }),
  ratchet: playbook({
    id: "ratchet", title: "Ratchet", version: 1, source: "dsx:ratchet",
    when: ["tighten checks", "reduce exception list", "one-way migration"],
    requires: ["role:coordinator", "role:worker", "role:reviewer", "role:verifier"],
    stages: [
      { id: "tighten", role: "coordinator" },
      { id: "fix", role: "worker", needs: ["tighten"], outputs: ["commit"] },
      { id: "review", role: "reviewer", needs: ["commit"], gate: "review" },
      { id: "verify", role: "verifier", needs: ["commit"], gate: "verify" },
      { id: "accept", role: "human", needs: ["review", "verify"] },
    ],
    gates: [
      { id: "review", predicate: "no_blocking_findings" },
      { id: "verify", predicate: "exception_list_decreased" },
    ],
    allowed_next: ["review"],
  }),
  hillclimb: playbook({
    id: "hillclimb", title: "Hillclimb", version: 1, source: "dsx:hillclimb",
    when: ["measurable optimization", "latency", "size", "accuracy"],
    requires: ["role:worker", "role:verifier"],
    stages: [
      { id: "measure", role: "verifier" },
      { id: "iterate", role: "worker", needs: ["measure"], outputs: ["metric"] },
      { id: "verify", role: "verifier", needs: ["metric"] },
      { id: "decide", role: "human", needs: ["verify"] },
    ],
    allowed_next: [],
  }),
  eval: playbook({
    id: "eval", title: "Eval", version: 1, source: "dsx:eval",
    when: ["quality evaluation", "blind arena", "candidate comparison"],
    requires: ["role:coordinator", "role:worker", "role:verifier"],
    stages: [
      { id: "frame", role: "coordinator" },
      { id: "candidates", role: "worker", needs: ["frame"] },
      { id: "judge", role: "verifier", needs: ["candidates"] },
      { id: "decide", role: "human", needs: ["judge"] },
    ],
    allowed_next: [],
  }),
  orchestrate: playbook({
    id: "orchestrate", title: "Orchestrate", version: 1, source: "dsx:orchestrate",
    when: ["multi-day program", "multi-PR stack", "continuous intake"],
    requires: ["role:coordinator", "role:worker", "role:verifier"],
    stages: [
      { id: "frame", role: "coordinator" },
      { id: "drain", role: "worker", needs: ["frame"] },
      { id: "verify", role: "verifier", needs: ["drain"] },
      { id: "decide", role: "human", needs: ["verify"] },
    ],
    allowed_next: ["feature", "bug-fix", "refactoring", "review"],
  }),
};

const PLAYBOOK_ALIASES: Record<string, string> = {
  "dsx-playbook-feature": "feature",
  "dsx-playbook-bug-fix": "bug-fix",
  "dsx-playbook-review": "review",
  "dsx-playbook-investigation": "investigation",
  "dsx-playbook-refactoring": "refactoring",
  "dsx-playbook-prototype": "prototype",
  "dsx-playbook-ratchet": "ratchet",
  "dsx-playbook-hillclimb": "hillclimb",
  "dsx-playbook-eval": "eval",
  "dsx-playbook-orchestrate": "orchestrate",
};

function readDefinitions<T>(directory: string): T[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const parsed: unknown = JSON.parse(readFileSync(join(directory, name), "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${name} must contain an object`);
      return parsed as T;
    });
}

export class CollaborationRegistry {
  readonly roles = new Map(Object.entries(BUILTIN_ROLES));
  readonly playbooks = new Map(Object.entries(BUILTIN_PLAYBOOKS));

  constructor(readonly configDir: string) {
    this.loadDirectory(configDir);
  }

  /** User config first; a project may add or override by id under .collie/. */
  loadDirectory(root: string): void {
    for (const role of readDefinitions<CollaborationRole>(join(root, "roles"))) {
      if (!role.id || !role.title) throw new Error("role requires id and title");
      this.roles.set(role.id, role);
    }
    for (const playbook of readDefinitions<CollaborationPlaybook>(join(root, "playbooks"))) {
      if (!playbook.id || !Array.isArray(playbook.stages) || !Number.isInteger(playbook.version)) {
        throw new Error("playbook requires id, version and stages");
      }
      for (const stage of playbook.stages) {
        if (!stage.id || !stage.role) throw new Error(`playbook ${playbook.id} has an invalid stage`);
        if (!this.roles.has(stage.role) && stage.role !== "human") {
          throw new Error(`playbook ${playbook.id} references unknown role ${stage.role}`);
        }
      }
      this.playbooks.set(playbook.id, playbook);
    }
  }

  loadProject(folder: string): void {
    this.loadDirectory(join(folder, ".collie"));
    this.loadDirectory(join(folder, ".agents", "skills", "collie"));
  }

  snapshot() {
    return {
      roles: [...this.roles.values()],
      playbooks: [...this.playbooks.values()],
    };
  }

  playbook(id: string): CollaborationPlaybook {
    const value = this.playbooks.get(PLAYBOOK_ALIASES[id] ?? id);
    if (!value) throw new Error(`unknown playbook: ${id}`);
    return value;
  }

  defaultPlaybook(kind: string): string {
    return kind === "review" ? "review" : "feature";
  }
}
