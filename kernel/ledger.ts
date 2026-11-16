import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

type Json = Record<string, any>;
type Entry = { seq: number; kind: "event" | "case" | "decision" | "receipt"; payload: Json };

const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
export const ledgerId = id;

/** One atomic document holds the append-only history; all indexes are derived, never separately written. */
export class Ledger {
  #entries: Entry[] = [];
  #sequences = new Map<string, number>();

  private constructor(readonly path: string) {}

  static open(path: string): Ledger {
    const ledger = new Ledger(resolve(path));
    if (existsSync(ledger.path)) {
      const saved = JSON.parse(readFileSync(ledger.path, "utf8"));
      if (saved.version !== 1 || !Array.isArray(saved.entries)) throw new Error("invalid collie ledger");
      ledger.#entries = saved.entries;
      for (const entry of ledger.#entries) {
        if (entry.payload.id) ledger.#sequences.set(entry.payload.id, entry.seq);
      }
    }
    return ledger;
  }

  #write(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, entries: this.#entries }), { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  append(kind: Entry["kind"], payload: Json): Json {
    if (kind === "event") {
      const duplicate = this.events.find((event) => event.source === payload.source && event.key === payload.key);
      if (duplicate) {
        if (duplicate.data_digest !== payload.data_digest) throw new Error("event key reused with different content");
        return duplicate;
      }
    }
    if (payload.id && this.#sequences.has(payload.id) && kind !== "decision") {
      throw new Error(`duplicate ${kind} id: ${payload.id}`);
    }
    const previousSeq = payload.id ? this.#sequences.get(payload.id) : undefined;
    const entry = { seq: this.#entries.length + 1, kind, payload: structuredClone(payload) };
    this.#entries.push(entry);
    if (payload.id) this.#sequences.set(payload.id, entry.seq);
    try { this.#write(); } catch (error) {
      this.#entries.pop();
      if (payload.id) {
        if (previousSeq === undefined) this.#sequences.delete(payload.id);
        else this.#sequences.set(payload.id, previousSeq);
      }
      throw error;
    }
    return structuredClone(payload);
  }

  latest<T extends Json = Json>(kind: Entry["kind"]): T[] {
    const revisions = new Map<string, T>();
    for (const entry of this.#entries) {
      if (entry.kind === kind) revisions.set(entry.payload.id ?? String(entry.seq), structuredClone(entry.payload));
    }
    return [...revisions.values()];
  }

  history<T extends Json = Json>(kind: Entry["kind"]): T[] {
    return this.#entries.filter((entry) => entry.kind === kind).map((entry) => structuredClone(entry.payload));
  }

  get events(): Json[] { return this.latest("event"); }
  get cases(): Json[] { return this.latest("case"); }
  get decisions(): Json[] { return this.latest("decision"); }
  get receipts(): Json[] { return this.latest("receipt"); }

  waiting(): Json[] {
    return this.decisions.filter((decision) => decision.state === "waiting").sort((a, b) =>
      (a.priority?.value ?? 5) - (b.priority?.value ?? 5) || a.decided_at.localeCompare(b.decided_at),
    );
  }
}
