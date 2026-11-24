// Thin wrapper over Herdr's own terminal pane/tab commands. The caller decides which
// terminal belongs to a role and whether opening it should steal focus; this module only
// guarantees one pane and a stable role-named tab.
import { exec, focused, panes, run, spaces, terminals } from "herdr";

const tabExists = (id) => Boolean(id) && spaces().some((space) => space.tabs.some((tab) => tab.id === id));

/** Give a live terminal a pane (if needed), rename its tab, and optionally focus it. */
export async function ensureTerminalTab({ terminal, name, focus = true, cx }) {
  const live = terminals().find((item) => item.address === terminal && item.state === "live");
  if (!live) throw new Error("The terminal isn't running.");

  const existing = panes().find((pane) => pane.terminal === terminal);
  if (existing && tabExists(existing.tab)) {
    run("tab.rename", { id: existing.tab, name });
    if (focus) {
      run("tab.select", { id: existing.tab });
      run("pane.focus", { terminal });
    }
    return existing.tab;
  }

  const previous = focus ? null : focused()?.tab;
  const result = await exec("herdr-app", ["do", "terminal.keep", "--terminal", terminal]);
  let out = {};
  try { out = JSON.parse(result.stdout || "{}"); } catch {}
  let tab = out.tab;
  for (let i = 0; (i < 20) && !tabExists(tab); i++) {
    const pane = panes().find((item) => item.terminal === terminal && tabExists(item.tab));
    if (pane) { tab = pane.tab; break; }
    await cx.sleep(50);
  }
  if (!tabExists(tab)) throw new Error(out.error || result.stderr || "Herdr didn't create a terminal tab");

  run("tab.rename", { id: tab, name });
  if (focus) {
    run("tab.select", { id: tab });
    run("pane.focus", { terminal });
  } else if (previous && previous !== tab && tabExists(previous)) {
    run("tab.select", { id: previous });
  }
  return tab;
}
