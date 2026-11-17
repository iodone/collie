import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Ingress } from "../kernel/ingress.ts";
import { loadProtocol } from "../protocol/validate.mjs";

const event = JSON.parse(await readFile(new URL("../protocol/fixtures/event.json", import.meta.url), "utf8"));
const { validate } = await loadProtocol(new URL("../protocol", import.meta.url).pathname);
const clone = <T>(value: T): T => structuredClone(value);
const commit = (n: number) => ({
  ...clone(event),
  id: `ev_commit${String(n).padStart(10, "0")}`,
  key: `mr!93@sha-${n}`,
  received_at: `2026-11-13T10:0${n}:00Z`,
});

describe("kernel/Ingress", () => {
  test("同一 MR 的 4 个 commit 只交 coordinator 判一次", () => {
    const ingress = new Ingress();
    const results = [1, 2, 3, 4].map((n) => ingress.ingest(commit(n)));

    expect(results.map((result) => result.dispatches.length)).toEqual([1, 0, 0, 0]);
    expect(results.slice(1).map((result) => result.status)).toEqual(["merged", "merged", "merged"]);
    const dispatch = results[0].dispatches[0];
    expect(dispatch.kind).toBe("coordinator");
    expect(dispatch.space).toBe("collie");
    expect(dispatch.laneKey).toBe("coordinator:mr:mr!93");
    const alive = ingress.eventForLane(dispatch.laneKey);
    expect(alive.key).toBe("mr!93@sha-4");
    expect(alive.merge.occurrences).toBe(4);
    expect(alive.merge.first_seen_at).toBe("2026-11-13T10:01:00Z");
    expect(validate(alive, "urn:collie:event:v1").errors).toEqual([]);
  });

  test("lane 完成后才开启下一轮，occurrences 继续累计", () => {
    const ingress = new Ingress();
    const first = ingress.ingest(commit(1)).dispatches[0];
    ingress.completeLane(first.laneKey);
    const next = ingress.ingest(commit(2));

    expect(next.status).toBe("accepted");
    expect(next.dispatches).toHaveLength(1);
    expect(next.dispatches[0].event.merge.occurrences).toBe(2);
  });

  test("同一 source + key 重投不重复判断，篡改正文则拒绝", () => {
    const ingress = new Ingress();
    ingress.ingest(commit(1));
    expect(ingress.ingest(commit(1)).status).toBe("duplicate");
    expect(() => ingress.ingest({ ...commit(1), data_digest: `sha256:${"0".repeat(64)}` })).toThrow("different immutable content");
  });

  test("所有事件都交给唯一候选 space 的 coordinator", () => {
    const result = new Ingress().ingest(commit(1));
    expect(result.dispatches[0]).toMatchObject({ kind: "coordinator", space: "collie" });
  });

  test("多 space 归属未被 Ingress 私自拍板", () => {
    const ambiguous = { ...commit(1), space_candidates: ["one-space", "other-space"] };
    expect(() => new Ingress().ingest(ambiguous)).toThrow("unresolved spaces");
  });

  test("hops > 8 只记录并要求出卡，不再派发", () => {
    const result = new Ingress().ingest({ ...commit(1), hops: 9 });
    expect(result.status).toBe("recorded");
    expect(result.dispatches[0]).toMatchObject({ kind: "record_only", cardRequired: true });
  });

  test("事件自带的执行字段在 trust boundary 被拒绝", () => {
    expect(() => new Ingress().ingest({ ...commit(1), cwd: "/tmp/other" })).toThrow("不得自带执行参数");
  });
});