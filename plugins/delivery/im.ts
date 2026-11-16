import {
  authorizedEmit,
  cliRunner,
  payload,
  type DeliveryOptions,
  type Json,
} from "./common.ts";

const runLark = cliRunner("lark-cli");

/** Payload: { text, chat_id? | user_id?, as: "bot"|"user" } (exactly one recipient). */
export async function deliverIm(decision: Json, options: DeliveryOptions = {}): Promise<unknown> {
  const egress = authorizedEmit(decision, "im");
  if (egress.op !== "notify") throw new Error("im delivery only supports notify");
  const data = await payload(egress);
  if (typeof data.text !== "string" || !data.text.trim()) throw new Error("payload.text must be non-empty");
  if (data.as !== "bot" && data.as !== "user") throw new Error("payload.as must explicitly be bot or user");
  if (Boolean(data.chat_id) === Boolean(data.user_id)) {
    throw new Error("payload requires exactly one of chat_id or user_id");
  }
  const recipientFlag = data.chat_id ? "--chat-id" : "--user-id";
  const recipient = data.chat_id ?? data.user_id;
  if (typeof recipient !== "string" || !recipient.trim() || /[\s\0\r\n]/.test(recipient)) {
    throw new Error("IM recipient must be a non-empty id");
  }

  return (options.run ?? runLark)([
    "im", "+messages-send", recipientFlag, recipient,
    "--text", data.text, "--as", data.as,
  ]);
}

export const deliverIM = deliverIm;
