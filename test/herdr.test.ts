import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { runHerdrTask, spawnHerdrTask, waitForHerdrReceipt, runningHerdrTasks } from "../plugins/agent/herdr.ts";
import { loadProtocol } from "../protocol/validate.mjs";

const decision = JSON.parse(await readFile(new URL("../protocol/fixtures/decision.json", import.meta.url), "utf8"));
const rule = {
  to: { kind: "herdr_task", space: "collie", cwd: { path: "/repo/collie", kind: "git" } },
  agent: { cli: "codex" },
};
const { validate } = await loadProtocol(new URL("../protocol", import.meta.url).pathname);
const fixedNow = new Date("2026-11-13T10:41:30Z");

function readyView() {
  return {
    id: 42,
    key: "HAT-42",
    state: "ready",
    started_at: 1_763_664_030_000,
    ready_at: 1_763_666_480_000,
    summary: "from the last message, which must not be used",
    evidence: {
      summary: "补完协议适配器并通过测试",
      details: "- MR 事件生成一个任务\n- 回执带凭据",
      commits: { list: [["9f2c1ab", "implement M1"]] },
      proof: { id: "art-proof-1", title: "node --test: 54 passed" },
    },
  };
}

function fakeRunner(views: Record<string, any>[]) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "add") return { id: 42, ref: "HAT-42" };
    if (args[0] === "start") return { id: 42, state: "running" };
    if (args[0] === "show") return views.length > 1 ? views.shift()! : views[0];
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  return { calls, run };
}

describe("plugins/agent/herdr", () => {
  test("一条 MR Decision 变成一个 ready 回执，对话零注入", async () => {
    const fake = fakeRunner([
      { id: 42, key: "HAT-42", state: "running", started_at: 1_763_664_030_000 },
      readyView(),
    ]);
    const receipt = await runHerdrTask(decision, rule, {
      run: fake.run,
      now: () => fixedNow,
      sleep: async () => {},
    });

    expect(fake.calls.map((call) => call[0])).toEqual(["add", "start", "show", "show"]);
    expect(fake.calls.flat()).not.toContain("tell-assistant");
    expect(fake.calls.flat()).not.toContain("ready");
    expect(fake.calls[0]).toContain("--prompt-file");
    expect(fake.calls[0]).toContain(decision.actions[0].spawn.brief_ref);
    expect(fake.calls[0]).not.toContain("--prompt");
    expect(fake.calls[0]).not.toContain("review=on");
    expect(receipt.task.previous_state).toBe("running");
    expect(receipt.proof).toMatchObject({ id: "art-proof-1", title: "node --test: 54 passed" });
    expect(receipt.proof.refs).toEqual(["commit:9f2c1ab", "artifact:art-proof-1"]);
    expect(receipt.summary).not.toContain("last message");
    expect(receipt).not.toHaveProperty("review");
    expect(receipt).not.toHaveProperty("verification");
    expect(receipt).not.toHaveProperty("risk");
    const result = validate(receipt, "urn:collie:receipt:v1");
    expect(result.errors).toEqual([]);
  });

  test("普通 task 没有 review/verify 记录也能 ready，且不转发 helper CLI 或 merge 设置", async () => {
    const view = readyView();
    const fake = fakeRunner([view]);
    const receipt = await runHerdrTask(decision, {
      ...rule,
      reviewer: { cli: "claude", model: "sonnet", effort: "low" },
      to: { ...rule.to, verify: true },
    }, { run: fake.run, now: () => fixedNow, sleep: async () => {} });
    expect(fake.calls[0]).not.toContain("--reviewer");
    expect(fake.calls[0]).not.toContain("--reviewer-model");
    expect(fake.calls[0]).not.toContain("--reviewer-effort");
    expect(fake.calls[0].some((arg) => arg.startsWith("merge="))).toBe(false);
    expect(receipt).not.toHaveProperty("review");
    expect(receipt).not.toHaveProperty("verification");
    expect(validate(receipt, "urn:collie:receipt:v1").errors).toEqual([]);
  });

  test("长任务没 ready 只继续观察，不读最后消息、不判失败", async () => {
    const fake = fakeRunner([{ id: 42, key: "HAT-42", state: "running" }]);
    await expect(waitForHerdrReceipt(
      { ref: "HAT-42", folder: "/repo/collie", space: "collie", previousState: "todo" },
      decision,
      { run: fake.run, sleep: async () => {}, maxPolls: 3 },
    )).rejects.toThrow("did not reach ready after 3 polls");
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls.every((call) => call[0] === "show")).toBe(true);
  });

  test("缺 proof 的 ready 不能变成 Receipt", async () => {
    const view = readyView();
    view.evidence.proof = null;
    const fake = fakeRunner([view]);
    await expect(waitForHerdrReceipt(
      { ref: "HAT-42", folder: "/repo/collie", space: "collie", previousState: "running" },
      decision,
      { run: fake.run },
    )).rejects.toThrow("missing proof");
  });

  test("task 未 ready 就 done 时不伪造 Receipt", async () => {
    const fake = fakeRunner([{ id: 42, key: "HAT-42", state: "done" }]);
    await expect(waitForHerdrReceipt(
      { ref: "HAT-42", folder: "/repo/collie", space: "collie", previousState: "running" },
      decision,
      { run: fake.run },
    )).rejects.toThrow("done before a ready receipt");
  });

  test("护栏未解除时不许 add，也不许发聊天", async () => {
    const guarded = structuredClone(decision);
    guarded.risk = { tags: ["outbound_message"], forced_waiting: true };
    const fake = fakeRunner([]);
    await expect(spawnHerdrTask(guarded, rule, { run: fake.run })).rejects.toThrow("require a card");
    expect(fake.calls).toEqual([]);
  });

  test("标题与 brief 在命令行边界再次校验", async () => {
    const bad = structuredClone(decision);
    bad.actions[0].spawn.title = "--force";
    const fake = fakeRunner([]);
    await expect(spawnHerdrTask(bad, rule, { run: fake.run })).rejects.toThrow("safe collie-task title");
    expect(fake.calls).toEqual([]);
  });

  test("规则里的 ~/ cwd 在 execFile 边界展开，不依赖 shell", async () => {
    const fake = fakeRunner([]);
    const homeRule = structuredClone(rule);
    homeRule.to.cwd.path = "~/work/collie";
    await spawnHerdrTask(decision, homeRule, { run: fake.run });
    expect(fake.calls[0][0]).toBe("add");
    expect(fake.calls[0][3]).not.toBe("~/work/collie");
    expect(fake.calls[0][3]).toContain("/work/collie");
  });

  test("事件侧字段不能越权决定 cwd 或权限", async () => {
    const fake = fakeRunner([]);
    await expect(spawnHerdrTask(decision, {
      to: { kind: "herdr_task", cwd: { path: "/tmp/state", kind: "state" } },
    }, { run: fake.run })).rejects.toThrow("git cwd");
    expect(fake.calls).toEqual([]);
  });

  test("add 缺 canonical ref 时不退回 key/id，也不启动 Task", async () => {
    const calls: string[][] = [];
    await expect(spawnHerdrTask(decision, rule, { run: async (args) => {
      calls.push(args);
      return { id: 42, key: "work-collie#42" };
    } })).rejects.toThrow("canonical task ref");
    expect(calls.map((call) => call[0])).toEqual(["add"]);
  });

  test("Case running 快照只读取同 space 的 running Task，并使用真实状态时间", async () => {
    const calls: string[][] = [];
    const running = await runningHerdrTasks("collie", {
      now: () => fixedNow,
      run: async (args) => {
        calls.push(args);
        return [
          { tasks: [
            { ref: "COLL-42", space: "collie", state: "running", started_at: fixedNow.getTime() - 65_000 },
            { ref: "COLL-41", space: "collie", state: "ready", started_at: fixedNow.getTime() - 100_000 },
            { ref: "COLL-40", space: "collie", state: "todo", started_at: null },
            { ref: "COLL-39", space: "collie", state: "done", started_at: fixedNow.getTime() - 200_000 },
            { ref: "OTHER-1", space: "other", state: "running", started_at: fixedNow.getTime() - 65_000 },
          ] },
        ];
      },
    });
    expect(calls).toEqual([["list", "--all", "--slim", "--json"]]);
    expect(running).toEqual([{
      task_id: "COLL-42", state: "running",
      state_changed_at: new Date(fixedNow.getTime() - 65_000).toISOString(), elapsed_seconds: 65,
    }]);
  });
});
