import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { runHerdrTask, spawnHerdrTask, waitForHerdrReceipt } from "../plugins/agent/herdr.ts";
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
    started: 1_763_664_030_000,
    ready_at: 1_763_666_480_000,
    summary: "from the last message, which must not be used",
    evidence: {
      summary: "补完协议适配器并通过测试",
      details: "- MR 事件生成一个任务\n- 回执带凭据",
      commits: { list: [["9f2c1ab", "implement M1"]] },
      proof: { id: "art-proof-1", title: "node --test: 54 passed" },
    },
    reviews: [{ result: "report", by: "t99", head: "9f2c1abd1234" }],
  };
}

function fakeRunner(views: Record<string, any>[]) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "add") return { id: 42, key: "HAT-42" };
    if (args[0] === "start") return { id: 42, state: "running" };
    if (args[0] === "show") return views.length > 1 ? views.shift()! : views[0];
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  return { calls, run };
}

describe("plugins/agent/herdr", () => {
  test("一条 MR Decision 变成一个 reviewed ready 回执，对话零注入", async () => {
    const fake = fakeRunner([
      { id: 42, key: "HAT-42", state: "running", started: 1_763_664_030_000 },
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
    expect(fake.calls[0]).toContain("review=on");
    expect(receipt.task.previous_state).toBe("working");
    expect(receipt.proof.refs).toEqual(["commit:9f2c1ab", "artifact:art-proof-1"]);
    expect(receipt.summary).not.toContain("last message");
    const result = validate(receipt, "urn:collie:receipt:v1");
    expect(result.errors).toEqual([]);
  });

  test("长任务没 ready 只继续观察，不读最后消息、不判失败", async () => {
    const fake = fakeRunner([{ id: 42, key: "HAT-42", state: "running" }]);
    await expect(waitForHerdrReceipt(
      { id: "42", key: "HAT-42", folder: "/repo/collie", space: "collie", previousState: "todo" },
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
      { id: "42", folder: "/repo/collie", space: "collie", previousState: "working" },
      decision,
      { run: fake.run },
    )).rejects.toThrow("missing proof");
  });

  test("缺 review 的 ready 不能变成 Receipt", async () => {
    const view = readyView();
    view.reviews = [];
    const fake = fakeRunner([view]);
    await expect(waitForHerdrReceipt(
      { id: "42", folder: "/repo/collie", space: "collie", previousState: "working" },
      decision,
      { run: fake.run },
    )).rejects.toThrow("no recorded review");
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
});
