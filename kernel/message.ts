type Json = Record<string, any>;

export interface HumanMessageInput {
  id: string;
  space: string;
  key: string;
  type: string;
  title: string;
  dataRef: string;
  dataDigest: string;
  at: string;
  project?: string;
}

/** The one envelope for a person's words. It is a Message, never a synthetic Event. */
export function humanMessage(input: HumanMessageInput): Json {
  return {
    id: input.id,
    source: "human",
    key: input.key,
    type: input.type,
    object: { kind: "none", id: input.id },
    title: input.title,
    data_ref: input.dataRef,
    data_digest: input.dataDigest,
    hops: 0,
    received_at: input.at,
    merge: {
      lane_key: `coordinator:none:${input.id}`,
      object_key: `none:${input.id}`,
      first_seen_at: input.at,
      occurrences: 1,
    },
    space_candidates: [input.space],
    ...(input.project ? { project: input.project } : {}),
  };
}
