import { answerCard } from "../../protocol/invariants.mjs";

type Json = Record<string, any>;

export interface ChannelOptions {
  beforeCommit?: (decision: Json) => Promise<Json | void> | Json | void;
}

/** Apply one Card answer and commit it. Incremental work goes through Quote, not coordinator resume. */
export async function answerHerdrCard(
  decision: Json,
  answer: Json,
  options: ChannelOptions = {},
): Promise<Json> {
  const answered = answerCard(decision, answer);
  const committed = await options.beforeCommit?.(answered) ?? answered;
  return { decision: committed };
}
