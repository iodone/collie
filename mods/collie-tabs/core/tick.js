// The tick wrapper's observable command sequence with its runtime dependencies injected.
export async function runTick({ exec, cli, store, terminals }) {
  await exec(cli, ["tick", "--json"]).catch(() => {});
  const r = await exec("sh", ["-c", 'ls "$1/.remote" 2>/dev/null; true', "x", store]).catch(() => null);
  const assisted = terminals().filter((k) => k.state === "live" && k.address.includes("/") && (k.labels?.["herdr.role"] === "coordinator" || k.labels?.["herdr.resume"]))
    .map((k) => k.address.split("/")[0]);
  for (const machine of new Set([...(r?.stdout ?? "").split("\n").filter((x) => x && !x.endsWith(".secret")), ...assisted])) {
    await exec(cli, ["--on", machine, "tick", "--json"]).catch(() => {});
  }
}
