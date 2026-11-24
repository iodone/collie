import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASK_FIRST } from "../protocol/constants.mjs";
import { answerCard } from "../protocol/invariants.mjs";
import { deliverGitlab } from "../plugins/delivery/gitlab.ts";
import { deliverGithub } from "../plugins/delivery/github.ts";
import { deliverIm } from "../plugins/delivery/im.ts";
import { answerHerdrCard } from "../plugins/channel/herdr.ts";

const fixture = JSON.parse(await readFile(new URL("../protocol/fixtures/card.json", import.meta.url), "utf8"));
const temp = await mkdtemp(join(tmpdir(), "collie-delivery-"));
let payloadSequence = 0;
const acceptedBy = { option: "accept", at: "2026-11-13T10:03:00Z", by: "mi" };

afterAll(async () => rm(temp, { recursive: true, force: true }));

async function payloadRef(value: Record<string, unknown>): Promise<string> {
  const path = join(temp, `payload-${payloadSequence++}.json`);
  await writeFile(path, JSON.stringify(value));
  return path;
}

function waitingEmit(target: string, op: string, ref: string, tags: string[] = []) {
  const decision = structuredClone(fixture);
  decision.actions.push({
    kind: "emit_command",
    risk_tags: tags,
    egress: { target, op, payload_ref: ref },
  });
  return decision;
}

function acceptedEmit(target: string, op: string, ref: string, tags: string[] = []) {
  return answerCard(waitingEmit(target, op, ref, tags), acceptedBy);
}

function mockRunner() {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args: string[]) => {
      calls.push(args);
      return { ok: true };
    },
  };
}

describe("plugins/delivery", () => {
  test("GitLab accept 后按 mock 边界发 MR 评论，正文只来自 payload 文件", async () => {
    const ref = await payloadRef({ repo: "example/herdr", id: 93, body: "reviewed\nready" });
    const fake = mockRunner();
    const output = await deliverGitlab(acceptedEmit("gitlab", "comment", ref, ["outbound_message"]), { run: fake.run });

    expect(output).toEqual({ ok: true });
    expect(fake.calls).toEqual([["mr", "note", "93", "--repo", "example/herdr", "--message", "reviewed\nready"]]);
  });

  test("GitLab merge 固定已验收 head，close 走 issue 命令面", async () => {
    const sha = "a".repeat(40);
    const mergeRef = await payloadRef({ repo: "example/herdr", id: "93", sha, merge_method: "squash" });
    const merge = mockRunner();
    await deliverGitlab(acceptedEmit("gitlab", "merge", mergeRef), { run: merge.run });
    expect(merge.calls[0]).toEqual([
      "mr", "merge", "93", "--repo", "example/herdr", "--yes", "--squash", "--sha", sha,
    ]);

    const closeRef = await payloadRef({ repo: "example/herdr", id: 17 });
    const close = mockRunner();
    const decision = acceptedEmit("gitlab", "close", closeRef);
    decision.occurrence = { ...decision.occurrence, kind: "issue", object_key: "issue:17" };
    await deliverGitlab(decision, { run: close.run });
    expect(close.calls[0]).toEqual(["issue", "close", "17", "--repo", "example/herdr"]);
  });

  test("GitHub accept 后调用 PR comment/merge，参数不经过 shell", async () => {
    const commentRef = await payloadRef({ repo: "iodone/herdr", id: 42, body: "done; $(not-a-shell)" });
    const comment = mockRunner();
    await deliverGithub(acceptedEmit("github", "comment", commentRef, ["outbound_message"]), { run: comment.run });
    expect(comment.calls).toEqual([["pr", "comment", "42", "--repo", "iodone/herdr", "--body", "done; $(not-a-shell)"]]);

    const sha = "b".repeat(40);
    const mergeRef = await payloadRef({ repo: "iodone/herdr", id: 42, sha, merge_method: "rebase" });
    const merge = mockRunner();
    await deliverGithub(acceptedEmit("github", "merge", mergeRef), { run: merge.run });
    expect(merge.calls[0]).toEqual([
      "pr", "merge", "42", "--repo", "iodone/herdr", "--rebase", "--match-head-commit", sha,
    ]);
  });

  test("IM accept 后使用明确收件人与身份调用 lark-cli 边界", async () => {
    const ref = await payloadRef({ chat_id: "oc_test", text: "MR ready", as: "bot" });
    const fake = mockRunner();
    await deliverIm(acceptedEmit("im", "notify", ref, ["outbound_message"]), { run: fake.run });
    expect(fake.calls).toEqual([["im", "+messages-send", "--chat-id", "oc_test", "--text", "MR ready", "--as", "bot"]]);
  });

  test("askFirst 七条都不能靠 risk 自填或无 answer 绕过，未授权零外发", async () => {
    for (const tag of ASK_FIRST) {
      const ref = await payloadRef({ repo: "example/herdr", id: 93, body: "must not send" });
      const decision = waitingEmit("gitlab", "comment", ref, [tag]);
      decision.risk = { tags: [], forced_waiting: false };
      const fake = mockRunner();
      await expect(deliverGitlab(decision, { run: fake.run })).rejects.toThrow("human accept");
      expect(fake.calls).toEqual([]);
    }
  });

  test("三个 delivery 都拒绝非 human accept 的决定", async () => {
    const cases = [
      { target: "gitlab", op: "comment", data: { repo: "example/herdr", id: 93, body: "no" }, deliver: deliverGitlab },
      { target: "github", op: "merge", data: { repo: "iodone/herdr", id: 42 }, deliver: deliverGithub },
      { target: "im", op: "notify", data: { chat_id: "oc_test", text: "no", as: "bot" }, deliver: deliverIm },
    ];
    for (const item of cases) {
      const ref = await payloadRef(item.data);
      const decision = waitingEmit(item.target, item.op, ref);
      decision.state = "open";
      const fake = mockRunner();
      await expect(item.deliver(decision, { run: fake.run })).rejects.toThrow("human accept");
      expect(fake.calls).toEqual([]);
    }
  });

  test("payload_ref 只接受绝对路径，拒绝时 runner 零调用", async () => {
    const decision = acceptedEmit("github", "comment", "relative/payload.json", ["outbound_message"]);
    const fake = mockRunner();
    await expect(deliverGithub(decision, { run: fake.run })).rejects.toThrow("absolute path");
    expect(fake.calls).toEqual([]);
  });
});

describe("plugins/channel/herdr", () => {
  test("accept 续接明确 coordinator address，hops 不变且回答随命令回传", async () => {
    const decision = structuredClone(fixture);
    decision.occurrence.hops = 6;
    const fake = mockRunner();
    const result = await answerHerdrCard(decision, acceptedBy, "laptop>vm-1/t23", { run: fake.run });

    expect(result.resumed).toBe(true);
    expect(result.decision.occurrence.hops).toBe(6);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].slice(0, 2)).toEqual(["send", "laptop>vm-1/t23"]);
    expect(fake.calls[0][3]).toBe("--json");
    const message = JSON.parse(fake.calls[0][2]);
    expect(message).toMatchObject({ type: "card.answer", decision_ref: decision.id, hops: 6 });
    expect(message.answer).toMatchObject(acceptedBy);
  });

  test("rework 续接同一显式地址并携带结构化批注", async () => {
    const fake = mockRunner();
    const answer = {
      option: "rework", at: "2026-11-13T10:03:00Z", by: "mi",
      annotations: [{ file: "plugins/delivery/gitlab.ts", line: 10, note: "保留 head sha 校验" }],
    };
    const result = await answerHerdrCard(fixture, answer, "t23", { run: fake.run });
    expect(result.decision.state).toBe("open");
    expect(JSON.parse(fake.calls[0][2]).answer.annotations).toEqual(answer.annotations);
  });

  test("drop/later 只回答卡片，不发任何命令", async () => {
    for (const option of ["drop", "later"]) {
      const fake = mockRunner();
      const answer = { ...acceptedBy, option, ...(option === "later" ? { snooze_until: "2026-11-13T12:00:00Z" } : {}) };
      const result = await answerHerdrCard(fixture, answer, undefined, { run: fake.run });
      expect(result.resumed).toBe(false);
      expect(result.decision.occurrence.hops).toBe(fixture.occurrence.hops);
      expect(fake.calls).toEqual([]);
    }
  });

  test("accept 缺地址时拒绝，绝不拿 space 猜 coordinator", async () => {
    const fake = mockRunner();
    await expect(answerHerdrCard(fixture, acceptedBy, undefined, { run: fake.run }))
      .rejects.toThrow("explicit coordinator address");
    expect(fake.calls).toEqual([]);
  });
});
