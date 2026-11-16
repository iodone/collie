import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { answerCard } from "../../protocol/invariants.mjs";

const execFileAsync = promisify(execFile);

type Json = Record<string, any>;
export type ChannelRunner = (args: string[]) => Promise<unknown>;

export interface ChannelOptions {
  run?: ChannelRunner;
  beforeResume?: (decision: Json) => Promise<void> | void;
}

const defaultRunner: ChannelRunner = async (args) => {
  const { stdout } = await execFileAsync("herdr-task", args, { maxBuffer: 4 * 1024 * 1024 });
  return stdout;
};

/** Apply the protocol answer first, then resume only the explicitly supplied coordinator address. */
export async function answerHerdrCard(
  decision: Json,
  answer: Json,
  coordinatorAddress?: string,
  options: ChannelOptions = {},
): Promise<Json> {
  const answered = answerCard(decision, answer);
  await options.beforeResume?.(answered);
  if (answer.option === "drop" || answer.option === "later") {
    return { decision: answered, resumed: false };
  }
  if (typeof coordinatorAddress !== "string" || !coordinatorAddress.trim()
    || /^[\s-]|[\0\r\n]/.test(coordinatorAddress)) {
    throw new Error("an explicit coordinator address is required to resume the original session");
  }

  const message = JSON.stringify({
    type: "card.answer",
    decision_ref: decision.id,
    answer: answered.card.answer,
    hops: answered.occurrence.hops,
  });
  const output = await (options.run ?? defaultRunner)(["tell-assistant", coordinatorAddress, message]);
  return { decision: answered, resumed: true, output };
}
