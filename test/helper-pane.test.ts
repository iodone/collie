import { describe, expect, test } from "bun:test";
import {
  FALLBACK, PANEL, STACK, TERM, find, helperTerminal, helperVisibility, pointHelper,
} from "../lib/helper-pane.js";

const helper = (space, address = "h1") => ({
  address, state: "live", labels: { "herdr.role": "helper", "herdr.job.space": space },
});

describe("Coordinator helper right pane", () => {
  test("Hidden 是默认；space 覆盖 Everywhere；没有 Off", () => {
    expect(helperVisibility({}, "alpha")).toBe("hidden");
    expect(helperVisibility(null, "alpha")).toBe("hidden");
    expect(helperVisibility({ everywhere: { coordinator: { helper: "visible" } } }, "alpha")).toBe("visible");
    expect(helperVisibility({
      everywhere: { coordinator: { helper: "visible" } },
      spaces: { alpha: { coordinator: { helper: "hidden" } } },
    }, "alpha")).toBe("hidden");
    expect(helperVisibility({ everywhere: { coordinator: { helper: "off" } } }, "alpha")).toBe("hidden");
  });

  test("只认本 space 的 live helper；kept shell 不算", () => {
    expect(helperTerminal([helper("alpha")], "alpha")?.address).toBe("h1");
    expect(helperTerminal([helper("beta")], "alpha")).toBeNull();
    expect(helperTerminal([{ ...helper("alpha"), state: "done" }], "alpha")).toBeNull();
    expect(helperTerminal([helper("alpha")], "machine/alpha")?.address).toBe("h1");
  });

  test("Visible 把 terminal 放进 panel-body 并复用同一个 block", () => {
    const tree = { id: "root", type: "column", children: [{ id: STACK, type: "stack", active: "collie", children: [{ id: "collie" }] }] };
    const added = pointHelper(tree, "h1");
    expect(added.changed).toBe(true);
    const block = find(added.tree, TERM);
    expect(block).toEqual({ id: TERM, type: "block", content: { terminal: "h1" } });
    expect(find(added.tree, STACK).children.at(-1).id).toBe(TERM);
    expect(pointHelper(added.tree, "h1").changed).toBe(false);
    pointHelper(added.tree, "h2");
    expect(find(added.tree, STACK).children.filter((child) => child.id === TERM)).toHaveLength(1);
    expect(find(added.tree, TERM).content.terminal).toBe("h2");
    expect(PANEL).toBe("panel");
    expect(FALLBACK).toBe("collie");
  });

  test("没有 panel-body 时不做破坏性写入", () => {
    const tree = { id: "root" };
    expect(pointHelper(tree, "h1")).toMatchObject({ changed: false, body: null });
    expect(tree).toEqual({ id: "root" });
  });
});
