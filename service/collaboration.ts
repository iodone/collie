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
};

const role = (value: CollaborationRole): CollaborationRole => value;

const playbook = (value: CollaborationPlaybook): CollaborationPlaybook => value;

export const BUILTIN_ROLES: Record<string, CollaborationRole> = {
  coordinator: role({
    id: "coordinator",
    title: "Coordinator",
    purpose: "把事件和人的意图变成有边界的 Task",
    duties: ["判断事件是否需要行动", "选择 playbook", "生成 Ticket / Task", "处理人的 steering 和 Card"],
    prohibitions: ["不写产品代码", "不做 review / verify", "不直接修改 task 状态", "不替人裁决"],
    modes: {
      event: { input: "event_job", output: "decision" },
      chat: { input: "human_message", output: "decision+reply", tools: ["ticket.create", "ticket.update", "card.answer"] },
    },
  }),
  worker: role({
    id: "worker", title: "Worker", purpose: "在 task folder/worktree 内交付实现",
    duties: ["按 brief 实现", "运行定向检查", "提交 commit", "提交 ready receipt"],
    prohibitions: ["不扩大范围", "不替自己验收", "不修改 Ledger"],
  }),
  reviewer: role({
    id: "reviewer", title: "Reviewer", purpose: "判断改动该不该这样写",
    duties: ["读 diff 与 brief", "按 Spec / Standards / 结构审查", "报告 findings 与 unproven"],
    prohibitions: ["不改代码", "不跑三验", "不裁决合并"],
  }),
  verifier: role({
    id: "verifier", title: "Verifier", purpose: "判断改动能不能用",
    duties: ["复跑检查", "实驱真实表面", "给出 verdict 与 evidence"],
    prohibitions: ["不改产品代码", "不替 worker 修", "不裁决合并"],
  }),
  planner: role({
    id: "planner", title: "Planner", purpose: "在实现前给出结构与接口方案",
    duties: ["提出候选设计", "比较 tradeoffs", "写 pass predicate"],
    prohibitions: ["不直接交付实现", "不替 review / verify"],
  }),
  researcher: role({
    id: "researcher", title: "Researcher", purpose: "只读调查并产出有引用的解释",
    duties: ["建立心智模型", "追踪代码与历史", "输出事实与不确定项"],
    prohibitions: ["不改产品代码", "不开 PR"],
  }),
};

export const BUILTIN_PLAYBOOKS: Record<string, CollaborationPlaybook> = {
  feature: playbook({
    id: "feature", title: "Feature", version: 1,
    when: ["new behavior", "changed behavior", "human build request"],
    stages: [
      { id: "implement", role: "worker", outputs: ["commit"] },
      { id: "review", role: "reviewer", needs: ["commit"], parallel_with: "verify", gate: "review" },
      { id: "verify", role: "verifier", needs: ["commit"], parallel_with: "review", gate: "verify" },
      { id: "accept", role: "human", needs: ["review", "verify"] },
    ],
    gates: [
      { id: "review", predicate: "no_blocking_findings" },
      { id: "verify", predicate: "verdict_pass" },
    ],
  }),
  review: playbook({
    id: "review", title: "Review", version: 1,
    when: ["reviewer assigned", "review requested"],
    stages: [
      { id: "review", role: "reviewer", gate: "review" },
      { id: "accept", role: "human", needs: ["review"] },
    ],
    gates: [{ id: "review", predicate: "no_blocking_findings" }],
  }),
  "bug-fix": playbook({
    id: "bug-fix", title: "Bug fix", version: 1,
    when: ["defect", "regression", "failing check"],
    stages: [
      { id: "reproduce", role: "coordinator" },
      { id: "fix", role: "worker", outputs: ["commit"] },
      { id: "review", role: "reviewer", needs: ["commit"], parallel_with: "verify", gate: "review" },
      { id: "verify", role: "verifier", needs: ["commit"], parallel_with: "review", gate: "verify" },
      { id: "accept", role: "human", needs: ["review", "verify"] },
    ],
    gates: [
      { id: "review", predicate: "no_blocking_findings" },
      { id: "verify", predicate: "repro_passes" },
    ],
  }),
  investigation: playbook({
    id: "investigation", title: "Investigation", version: 1,
    when: ["read-only question", "design investigation"],
    stages: [
      { id: "investigate", role: "researcher" },
      { id: "accept", role: "human", needs: ["investigate"] },
    ],
  }),
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

  playbook(id: string): CollaborationPlaybook {
    const value = this.playbooks.get(id);
    if (!value) throw new Error(`unknown playbook: ${id}`);
    return value;
  }

  defaultPlaybook(kind: string): string {
    return kind === "review" ? "review" : "feature";
  }
}
