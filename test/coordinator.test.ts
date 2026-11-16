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
const decision = (why = "低风险事件，无需行动") => ({ state: "routed", why, actions: [{ kind: "noop", risk_tags: [] }] });
const dispatchFor = (n: number) => {
  const source = { ...clone(event), id: `ev_test${String(n).padStart(12, "0")}`, key: `mr!93@${n}` };
  const ingress = new Ingress(clone(ruleset));
  ingress.completeLane;
  return ingress.ingest(source).dispatches[0];
};

afterEach(() => { while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true }); });

describe("M3 Coordinator + Ledger", () => {
  test("job turn 生成有界 Case，Decision 带 why 落账且可回放", async () => {
    const path = join(scratch(), "ledger.json");
    const ledger = Ledger.open(path);
    const dispatch = dispatchFor(1);
    ledger.append("event", dispatch.event);
    let seen: any;
    const result = await coordinate(dispatch, {
      ledger, ruleset, decide: (job) => { seen = job; return decision(); },
      now: () => new Date("2026-11-13T10:00:00Z"),
    });

    expect(seen.visibility).toBe("ledger_only");
    expect(seen.snapshot.bytes).toBeLessThanOrEqual(4096);
    expect(result.why).toBe("低风险事件，无需行动");
    expect(result.case_ref).toBe(seen.id);
    expect(validate(result, "urn:collie:decision:v1").errors).toEqual([]);
    const reopened = Ledger.open(path);
    expect(reopened.decisions[0].id).toBe(result.id);
    expect(reopened.events[0].id).toBe(dispatch.event.id);
    expect(JSON.parse(readFileSync(path, "utf8")).entries.map((entry: any) => entry.kind)).toEqual(["event", "case", "decision"]);
  });

  test("全局 6 次预算用完后第 7 次不调用 coordinator，只落 waiting 卡", async () => {
    const ledger = Ledger.open(join(scratch(), "ledger.json"));
    let calls = 0;
    for (let n = 1; n <= 7; n += 1) {
      const dispatch = dispatchFor(n);
      // Independent lanes model seven unrelated objects.
      dispatch.event = { ...dispatch.event, id: `ev_budget${String(n).padStart(10, "0")}`, key: `mr!${n}@head`, object: { ...dispatch.event.object, id: `mr!${n}` } };
      dispatch.event.merge = { ...dispatch.event.merge, lane_key: `mr-review:mr:mr!${n}`, object_key: `mr:mr!${n}` };
      await coordinate(dispatch, {
        ledger, ruleset, decide: () => { calls += 1; return decision(`决定 ${n}`); },
        now: () => new Date("2026-11-13T10:00:00Z"),
      });
    }
    expect(calls).toBe(6);
    expect(ledger.cases).toHaveLength(6);
    expect(ledger.decisions.at(-1).state).toBe("waiting");
    expect(ledger.decisions.at(-1).case_ref).toBeNull();
  });

  test("coordinator 改不了 hops；full 权限被护栏钉成 approval 卡", async () => {
    const ledger = Ledger.open(join(scratch(), "ledger.json"));
    const result = await coordinate(dispatchFor(1), {
      ledger, ruleset,
      decide: () => ({
        state: "routed", why: "试图放大跳数并提升权限",
        occurrence: { object_key: "mr:mr!93", kind: "mr", round: 1, hops: 99 },
        actions: [{ kind: "spawn_task", risk_tags: [], spawn: {
          title: "test", brief_ref: "/tmp/brief.md", base: "main", review: true, merge: false, access: "full", tells: "never",
        } }],
      }),
    });
    expect(result.occurrence.hops).toBe(0);
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
});
