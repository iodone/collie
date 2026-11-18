import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
type Json = Record<string, any>;

export interface CoordinatorConfig {
  cli: "claude" | "codex";
  model?: string;
  effort?: string;
  args?: string[];
  resume_args?: string[];
  /** Optional interactive argv for the persistent helper; defaults to the CLI's interactive mode. */
  helper_args?: string[];
}

export interface CoordinatorRunnerInput {
  command: string;
  args: string[];
  input: string;
}
export type CoordinatorRunner = (input: CoordinatorRunnerInput) => Promise<string>;

export function coordinatorConfig(settings: Json, space: string): CoordinatorConfig {
  const everywhere = settings.everywhere?.coordinator ?? {};
  const local = settings.spaces?.[space]?.coordinator ?? {};
  const config = { ...everywhere, ...local };
  if (!["claude", "codex"].includes(config.cli)) {
    throw new Error(`space ${space} needs coordinator.cli = claude or codex`);
  }
  return config as CoordinatorConfig;
}

function cliArgs(config: CoordinatorConfig, session?: string): string[] {
  if (session && config.resume_args) return config.resume_args.map((arg) => arg.replace("{session}", session));
  if (config.args) return config.args;
  const model = config.model && config.model !== "default" ? config.model : null;
  if (config.cli === "codex") {
    if (session) return ["exec", "resume", session, "--json", "-"];
    return ["exec", "--json", "-", ...(model ? ["--model", model] : [])];
  }
  return [
    "-p", "--output-format", "json",
    ...(session ? ["--resume", session] : []),
    ...(model ? ["--model", model] : []),
  ];
}

const defaultRunner: CoordinatorRunner = ({ command, args, input }) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`coordinator exited ${code}: ${stderr.slice(0, 500)}`)));
  child.stdin.end(input);
});

function decisionText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const value = output as Json;
    for (const key of ["result", "text", "message", "content"]) {
      if (typeof value[key] === "string") return value[key];
    }
  }
  throw new Error("coordinator output has no Decision text");
}

function parseOutput(stdout: string): { decision: Json; session: string | null } {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("coordinator returned no output");
  try {
    const direct = JSON.parse(trimmed);
    if (direct.actions) return { decision: direct, session: direct.session_id ?? direct.session ?? null };
    return { decision: JSON.parse(decisionText(direct)), session: direct.session_id ?? direct.session ?? null };
  } catch { /* JSONL or fenced output below */ }

  const events = trimmed.split("\n").flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const session = events.map((event) => event.session_id ?? event.session ?? event.thread_id).find(Boolean) ?? null;
  const texts = events.flatMap((event) => { try { return [decisionText(event)]; } catch { return []; } });
  const candidate = texts.at(-1) ?? trimmed;
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  return { decision: JSON.parse(fenced?.[1] ?? candidate), session };
}

export async function runCoordinator(
  job: Json,
  config: CoordinatorConfig,
  options: { run?: CoordinatorRunner; session?: string } = {},
): Promise<{ decision: Json; session: string | null }> {
  const prompt = `${await readFile(job.instruction.role_prompt_ref, "utf8")}\n\n只输出一个符合 ${job.instruction.output_contract} 的 Decision JSON。\n${JSON.stringify(job)}`;
  const output = await (options.run ?? defaultRunner)({
    command: config.cli,
    args: cliArgs(config, options.session),
    input: prompt,
  });
  const parsed = parseOutput(output);
  if (!Array.isArray(parsed.decision.actions)) throw new Error("coordinator Decision has no actions");
  return parsed;
}
