import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ingress } from "../kernel/ingress.ts";
import { Ledger } from "../kernel/ledger.ts";
import { coordinate } from "../kernel/coordinator.ts";
import { loadProtocol } from "../protocol/validate.mjs";

const event = await Bun.file(new URL("../protocol/fixtures/event.json", import.meta.url)).json();
const ruleset = await Bun.file(new URL("../protocol/fixtures/ruleset.json", import.meta.url)).json();
const { validate } = await loadProtocol(new URL("../protocol", import.meta.url).pathname);
const temporary: string[] = [];
const scratch = () => { const path = mkdtempSync(join(tmpdir(), "collie-")); temporary.push(path); return path; };
const clone = <T>(value: T): T => structuredClone(value);
const decision = (why = "低风险事件，无需行动") => ({ state: "open", why, actions: [{ kind: "noop", risk_tags: [] }] });
const dispatchFor = (n: number) => {
  const source = { ...clone(event), id: `ev_test${String(n).padStart(12, "0")}`, key: `mr!93@${n}` };
  const ingress = new Ingress();
  return ingress.ingest(source).dispatches[0];
};

afterEach(() => { while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true }); });

describe("M3 Coordinator + Ledger", () => {
  test("event Message 生成有界 Case，Decision 带 why 落账且可回放", async () => {
    const path = join(scratch(), "ledger.json");
    const ledger = Ledger.open(path);
    const dispatch = dispatchFor(1);
    ledger.append("event", dispatch.event);
    let seen: any;
    const catalog = {
      playbooks: [{ name: "feature", description: "Feature", version: 4 }],
    };
    const result = await coordinate(dispatch, {
      ledger, ruleset, catalog, decide: (job) => { seen = job; return decision(); },
      now: () => new Date("2026-11-13T10:00:00Z"),
    });

    expect(seen.origin).toBe("event");
    expect(seen.catalog).toEqual(catalog);
    expect(seen.snapshot.bytes).toBeLessThanOrEqual(4096);
    expect(result.why).toBe("低风险事件，无需行动");
    expect(result.case_ref).toBe(seen.id);
    expect(validate(result, "urn:collie:decision:v1").errors).toEqual([]);
    const reopened = Ledger.open(path);
    expect(reopened.decisions[0].id).toBe(result.id);
    expect(reopened.events[0].id).toBe(dispatch.event.id);
    expect(JSON.parse(readFileSync(path, "utf8")).entries.map((entry: any) => entry.kind)).toEqual(["event", "case", "decision", "decision"]);
    expect(ledger.history("decision").map((item) => item.state)).toEqual(["open", "open"]);
  });

  test("Case.active 提供活跃 Decision、动作、目标、详情与 orphan Task", async () => {
    const ledger = Ledger.open(join(scratch(), "ledger.json"));
    ledger.append("decision", {
      id: "dc_active01", space: "collie", state: "open", why: "评审发布方案",
      decided_at: "2026-11-13T09:00:00Z",
      occurrence: { object_key: "none:publish", kind: "none", round: 1, hops: 0 },
      run: { task_ref: "TASK-7", kind: "review" },
      actions: [{ kind: "spawn_task", risk_tags: [], spawn: { title: "评审发布方案", brief_ref: "/tmp/review.md" } }],
    });
    ledger.append("decision", {
      id: "dc_settled01", space: "collie", state: "settled", why: "已结束",
      decided_at: "2026-11-13T09:30:00Z", run: { task_ref: "TASK-OLD", kind: "build" },
      occurrence: { object_key: "none:old", kind: "none", round: 1, hops: 0 },
    });
    let active: unknown;
    await coordinate(dispatchFor(1), {
      ledger, ruleset,
      activeTasks: [
        { ref: "TASK-7", title: "评审发布方案", state: "running", space: "collie" },
        { ref: "TASK-9", title: "核对发布检查单", state: "ready", space: "collie" },
        { ref: "TASK-10", title: "已结束", state: "done", space: "collie" },
      ],
      decide: (job) => { active = job.snapshot.active; return decision(); },
    });
    expect(active).toEqual([
      {
        decision_id: "dc_active01", task_ref: "TASK-7", kind: "review", goal: "评审发布方案",
        detail_ref: "/tmp/review.md", decision_state: "open", task_state: "running",
      },
      {
        decision_id: null, task_ref: "TASK-9", kind: null, goal: "核对发布检查单",
        detail_ref: null, decision_state: null, task_state: "ready",
      },
    ]);
  });

  test("decision_ref 续接同一 Decision 和 Task，round 增加且不新建", async () => {
    const ledger = Ledger.open(join(scratch(), "ledger.json"));
    const first = await coordinate(dispatchFor(1), {
      ledger, ruleset,
      decide: () => ({ state: "open", why: "产出发布方案", actions: [{ kind: "noop", risk_tags: [] }], run: { kind: "build", task_ref: "TASK-7" } }),
    });
    const continued = await coordinate(dispatchFor(2), {
      ledger, ruleset,
      decide: () => ({
        decision_ref: first.id, state: "open", why: "评审同一份发布方案",
        actions: [{ kind: "noop", risk_tags: [] }], run: { kind: "review" },
      }),
    });
    expect(continued.id).toBe(first.id);
    expect(first.occurrence.round).toBe(1);
    expect(continued.run).toMatchObject({ task_ref: "TASK-7", kind: "review" });
    expect(continued.occurrence.round).toBe(2);
    expect(ledger.decisions).toHaveLength(1);
  });

  test("decision_ref 只能引用同一 space 的活跃 Decision", async () => {
    const ledger = Ledger.open(join(scratch(), "ledger.json"));
    await expect(coordinate(dispatchFor(1), {
      ledger, ruleset,
      decide: () => ({ decision_ref: "dc_missing01", state: "open", why: "无效续接", actions: [{ kind: "noop", risk_tags: [] }] }),
    })).rejects.toThrow("unknown or settled decision_ref");
  });

  test("coordinator 改不了 hops；full 权限被护栏钉成 approval 卡", async () => {
    const ledger = Ledger.open(join(scratch(), "ledger.json"));
    const result = await coordinate(dispatchFor(1), {
      ledger, ruleset,
      decide: () => ({
        state: "open", why: "试图放大跳数并提升权限",
        occurrence: { object_key: "mr:mr!93", kind: "mr", round: 1, hops: 99 },
        actions: [{ kind: "spawn_task", risk_tags: [], spawn: {
          title: "test", brief_ref: "/tmp/brief.md", base: "main", access: "full",
        } }],
      }),
    });
    expect(result.occurrence.hops).toBe(1);
    expect(result.state).toBe("waiting");
    expect(result.card.kind).toBe("approval");
    expect(result.risk.tags).toContain("change_permission");
  });

  test("Event 去重是 Ledger 的持久约束，日志只追加", async () => {
    const ledger = Ledger.open(join(scratch(), "ledger.json"));
    ledger.append("event", event);
    ledger.append("event", event);
    expect(ledger.events).toHaveLength(1);
    expect(ledger.history("event")).toHaveLength(1);
    expect(() => ledger.append("event", { ...event, data_digest: `sha256:${"0".repeat(64)}` })).toThrow("different content");
  });

  test("ledger 目录首次创建，文件权限只允许 owner 读写", async () => {
    const path = join(scratch(), "nested", "ledger.json");
    const ledger = Ledger.open(path);
    ledger.append("event", event);
    expect(existsSync(path)).toBe(true);
    if (process.platform !== "win32") expect((await Bun.file(path).stat()).mode & 0o077).toBe(0);
  });

  test("priority/hold/propose_policy 投影到 Decision，第三 priority 出卡", async () => {
    const ledger = Ledger.open(join(scratch(), "ledger.json"));
    const first = await coordinate(dispatchFor(2), {
      ledger, ruleset,
      decide: () => ({ state: "open", why: "调序", actions: [
        { kind: "priority", risk_tags: [], priority: { target_task: "t-1", value: 2 } },
        { kind: "hold", risk_tags: [], hold: { target_task: "t-1", until: null, reason: "等人" } },
        { kind: "propose_policy", risk_tags: [], rule: { draft_ref: "/tmp/policy.md", summary: "避免重复判断" } },
      ] }),
    });
    expect(first.priority).toMatchObject({ value: 2 });
    expect(first.hold).toMatchObject({ until: null, reason: "等人" });
    expect(first.proposal).toMatchObject({ draft_ref: "/tmp/policy.md" });
  });

  test("同 object 第 3 次 priority 强制 waiting Card", async () => {
    const ledger = Ledger.open(join(scratch(), "ledger.json"));
    const decide = () => ({ state: "open", why: "调序", actions: [
      { kind: "priority", risk_tags: [], priority: { target_task: "t-1", value: 1 } },
    ] });
    await coordinate(dispatchFor(30), { ledger, ruleset, decide });
    await coordinate(dispatchFor(31), { ledger, ruleset, decide });
    const third = await coordinate(dispatchFor(32), { ledger, ruleset, decide });
    expect(third.state).toBe("waiting");
    expect(third.card.kind).toBe("approval");
  });

  test("waiting 投影与 Inbox 一致：hold 沉底、priority/年龄/id 稳定排序", () => {
    const ledger = Ledger.open(join(scratch(), "ledger.json"));
    const waiting = (id: string, extra: Record<string, unknown> = {}) => ({
      id, state: "waiting", why: id, decided_at: "2026-11-13T10:00:00Z",
      priority: null, hold: null, card: { created_at: "2026-11-13T10:00:00Z" }, ...extra,
    });
    for (const decision of [
      waiting("dc_held", { priority: { value: 0 }, hold: { until: null } }),
      waiting("dc_second", { priority: { value: 2 }, decided_at: "2026-11-13T10:02:00Z" }),
      waiting("dc_default", { decided_at: "2026-11-13T09:00:00Z" }),
      waiting("dc_first", { priority: { value: 0 }, decided_at: "2026-11-13T10:01:00Z" }),
      waiting("dc_earlier", { priority: { value: 2 }, decided_at: "2026-11-13T10:01:00Z" }),
      waiting("dc_b"), waiting("dc_a"),
    ]) ledger.append("decision", decision);
    expect(ledger.waiting().map((decision) => decision.id)).toEqual([
      "dc_first", "dc_earlier", "dc_second", "dc_default", "dc_a", "dc_b", "dc_held",
    ]);
  });
});
