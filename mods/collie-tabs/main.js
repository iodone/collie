import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, run, openOverlay, theme, window, shared, setShared, layout, settings, nextCommand, readTextFile, appHome } from "herdr";
import { spacesWithChats as spaces, sweep } from "./parked.js";
import { isCoordinatorTab, closeTab, watchNewSpaces, newSpace, openCoordinator, renameTab, renameSpace } from "./coordinator.js";
import { startTick, tickOnChange } from "./tick.js";
import { startInbox, countsByTab, readyByTab, showInbox, toAlert } from "./inbox-engine.js";
import { countBadge, H, TEXT, RADIUS } from "./lib/ui.js";
// A tab's name (what runs in it while Herdr named it): core/menus.js, as the web app's tab bar names it.
import { tabName } from "./core/menus.js";
import { inRender } from "./live.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init(_props, cx) {
    // Agents parked behind a chat whose tab or space closed end, as their pane would have (the
    // Agents list did this; the layout has none now).
    cx.timer.every(5000, () => sweep());
    this.pressed = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    // The tab context menu asks the tab bar to close through closeTab's guard.
    cx.timer.every(250, () => {
      const request = shared("collie.closeTabReq");
      if (!request) return;
      setShared("collie.closeTabReq", null);
      closeTab(request.id);
    });
    // Inbox queue and merge watcher (collie-task owns it): left to the service while it runs.
    startTick(cx);
    // What needs the person, for Inbox's "Needs you" and the red counts (inbox-engine.js).
    startInbox(cx);
    // Ctrl+Shift+W comes here so a coordinator with live workers asks first, like its x.
    // At most 5 s per wait (one pending nextCommand), so a reload's old build ends at its next
    // cx use instead of staying in memory.
    cx.spawn(async (cx) => {
      let cmd = null;
      for (;;) {
        cmd ??= nextCommand();
        const c = await Promise.race([cmd, cx.sleep(5000)]);
        if (c === undefined) continue;
        cmd = null;
        const tab = spaces().find(s => s.active)?.tabs.find(t => t.active);
        if (c === "close" && tab) closeTab(tab.id);
        // F2 / Shift+F2 (keys.json): our Rename dialogs for the shown tab and space.
        if (c === "rename-tab" && tab) renameTab(tab);
        if (c === "rename-space") { const sp = spaces().find(s => s.active); if (sp) renameSpace(sp.id); }
        // Ctrl+Shift+N: the New space dialog, on the shown space's machine.
        if (c === "space-new") newSpace(spaces().find(s => s.active));
        // This computer's + in the Spaces sidebar: the dialog here, whatever space is shown.
        if (c === "space-new-local") newSpace(null);
        // A machine's New space in the Spaces sidebar: the dialog there (shared "collie.space.on" =
        // { machine, at }, null machine: this computer). A script's way: data/collie-space-on.json
        // ({ machine }).
        if (c === "space-new-on") {
          let on = shared("collie.space.on");
          if (!on || Date.now() - on.at >= 10000) {
            try { on = { ...JSON.parse(await readTextFile(`${appHome()}/data/collie-space-on.json`) ?? "null"), at: Date.now() }; } catch { on = null; }
          }
          newSpace(on?.machine ? { machine: on.machine } : null);
        }
        // A space's coordinator tab, opened (a script's way to the + menu's Coordinator): the space
        // in data/coordinator-openreq.json ({ space }), else the shown one.
        if (c === "coordinator") {
          let id = null;
          try { id = JSON.parse(await readTextFile(`${appHome()}/data/coordinator-openreq.json`) ?? "null")?.space ?? null; } catch {}
          const s = spaces().find(s => (id ? s.id === id : s.active));
          if (s) openCoordinator(s, true);
        }
        // A toast's "needs you": the Inbox, on its Active tab.
        if (c === "collie") showInbox();
        // An agent's alert (collie-task alert), clicked: "alert-<terminal>" ("~" for "/"), to that agent (inbox-engine.js).
        if (c.startsWith("alert-")) toAlert({ terminal: c.slice(6).replace(/~/g, "/") });
      }
    });
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        // The old Tasks panel is gone: a space that had it open shows the Inbox.
        const stored = this.panels[space.id] === "tasks" ? "collie" : this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  // One copy of Herdr's live lists for the whole render (live.js): past ~50 ms Herdr stops it.
  render(cx) {
    return inRender(() => this.draw(cx));
  }

  draw(cx) {
    tickOnChange(cx);
    watchNewSpaces(spaces());
    const t = theme();
    const space = spaces().find(p => p.active);
    // A coordinator's tab is pinned first.
    const shown = [...(space?.tabs ?? [])].sort((a, b) => isCoordinatorTab(b.id) - isCoordinatorTab(a.id));
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(H.sm).flex_none().flex().items_center().justify_center().rounded(RADIUS.control).cursor_pointer().text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    // What needs the person, per tab (the Inbox's items), and Tasks' Ready: a red and a green
    // count on the tab.
    const needs = countsByTab(), readies = readyByTab();
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = tabName(c.name, program?.name);
      return h_flex().id(`tab-${c.id}`).h(H.sm).px(8).gap(6).rounded(RADIUS.control).items_center().flex_none().text_size(TEXT.body)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) renameTab(c); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "collie-menu", kind: "popup", width: 236, props: { target: { id: c.id, space: space.id, name: c.name, named: c.named } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/collie-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(needs.get(c.id) > 0 || readies.get(c.id) > 0, el => el.child(countBadge(needs.get(c.id), readies.get(c.id), c.active ? t.raised : t.chrome)))
        .when(!(needs.get(c.id) > 0 || readies.get(c.id) > 0) && (c.status === "blocked" || c.status === "done"), el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).cursor_pointer().text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); closeTab(c.id); }).child(svg("mods/collie-tabs/win-close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    // The panel's pages, all collie's own: Files, Inbox, Artifacts (the layout mounts them as
    // "files", "collie" and "artifacts"). Shep's pages are gone.
    const enabled = ["files", "collie", "artifacts"];
    const waiting = shared("inbox.queue")?.waiting ?? 0;
    this.syncPanel(space, panel, body, enabled);
    // The side panel's button: icon first; the label when the bar has room (the open one keeps
    // its label); a count after the icon (the Inbox's waiting work).
    const roomy = (this.width ?? 0) >= 1100;
    const panelButton = (id, label, icon, [need, ready] = [0, 0]) => {
      const badge = need + ready;
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(H.sm).pl(5).pr(roomy || on || badge ? 8 : 5).gap(5).flex_none().items_center().rounded(RADIUS.control)
        .text_size(TEXT.label).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .cursor_pointer().hover(s => s.bg(on ? t.selected : t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14).flex_none())
        .when(roomy || on, el => el.child(label))
        .when(badge > 0, el => el.child(countBadge(need, ready, on ? t.selected : t.chrome)));
    };
    return h_flex().id("tabs-bar").size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_size_change((size, cx) => { this.width = size.width; cx.notify(); })
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250 })))
      .child(panelButton("files", "Files", "mods/collie-files/file.svg"))
      .child(panelButton("collie", "Inbox", "mods/collie-chrome/files.svg", [waiting, 0]))
      .child(panelButton("artifacts", "Artifacts", "mods/collie-artifacts/artifacts.svg"))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/collie-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/collie-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/collie-tabs/win-close.svg").size(16) : svg("mods/collie-tabs/win-close.svg").size(13), () => run("window.close"))));
  }
}
