import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, InputState, Input } from "gpui-base";
import { closeOverlay, home, props, readTextFile, spaces, theme, writeTextFile } from "herdr";
import { coordinatorPath, mergeCoordinator, mergeRole, mergeTaskSetting, taskSettingsPath } from "./lib/inbox-settings.js";
import { TEXT, RADIUS, H, button, segmented } from "./lib/ui.js";

const sectionIcon = "mods/collie-chrome/network.svg";

const EFFORTS = [["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "XHigh"], ["max", "Max"]];
const AGENTS = [["claude", "Claude"], ["codex", "Codex"]];

export default class InboxSettings extends View {
  init(_props, cx) {
    this.section = "coordinator";
    this.cfg = {};
    this.raw = null;
    this.ingressCfg = {};
    this.ingressRaw = null;
    this.taskCfg = {};
    this.taskRaw = null;
    this.savedAt = 0;
    this.model = InputState.new({ placeholder: "CLI default" });
    this.workerModel = InputState.new({ placeholder: "CLI default" });
    this.reviewerModel = InputState.new({ placeholder: "CLI default" });
    this.sourceInputs = {};
    this.clientInputs = {};
    this.newSource = InputState.new({ placeholder: "source name" });
    this.model.on("blur", (_e, cx) => this.saveCoordinator({ model: this.model.content().text.trim() }, cx));
    this.workerModel.on("blur", (_e, cx) => this.saveRole("worker", { model: this.workerModel.content().text.trim() }, cx));
    this.reviewerModel.on("blur", (_e, cx) => this.saveRole("reviewer", { model: this.reviewerModel.content().text.trim() }, cx));
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      await this.load();
      cx.notify();
    });
  }

  async load() {
    this.raw = await readTextFile(coordinatorPath(home())).catch(() => null);
    try { this.cfg = JSON.parse(this.raw ?? "{}"); } catch { this.cfg = {}; }
    this.model.set_value(this.cfg.everywhere?.coordinator?.model ?? "");

    this.ingressRaw = await readTextFile(`${home()}/.config/collie/sources.json`).catch(() => null);
    try { this.ingressCfg = JSON.parse(this.ingressRaw ?? "{}"); } catch { this.ingressCfg = {}; }
    this.ensureIngressInputs();

    this.taskRaw = await readTextFile(taskSettingsPath(home())).catch(() => null);
    try { this.taskCfg = JSON.parse(this.taskRaw ?? "{}"); } catch { this.taskCfg = {}; }
    this.workerModel.set_value(this.taskCfg.worker?.model ?? "");
    this.reviewerModel.set_value(this.taskCfg.reviewer?.model ?? "");
  }

  saved() { return this.savedAt ? div().text_size(TEXT.label).text_color(theme().dim).child("Saved") : null; }

  saveCoordinator(patch, cx) {
    cx.spawn(async (cx) => {
      try {
        const next = mergeCoordinator(this.cfg, {
          model: this.model.content().text.trim(),
          effort: this.cfg.everywhere?.coordinator?.effort ?? "high",
          ...patch,
        });
        await writeTextFile(coordinatorPath(home()), JSON.stringify(next, null, 2) + "\n", this.raw);
        this.cfg = next;
        this.raw = JSON.stringify(next, null, 2) + "\n";
        this.savedAt = Date.now();
      } catch (error) { this.error = String(error?.message ?? error); }
      cx.notify();
      cx.timer.after(2200, (cx) => { this.savedAt = 0; cx.notify(); });
    });
  }

  saveRole(role, patch, cx) {
    cx.spawn(async (cx) => {
      try {
        const next = mergeRole(this.taskCfg, role, patch);
        await writeTextFile(taskSettingsPath(home()), JSON.stringify(next, null, 2) + "\n", this.taskRaw);
        this.taskCfg = next;
        this.taskRaw = JSON.stringify(next, null, 2) + "\n";
        this.savedAt = Date.now();
      } catch (error) { this.error = String(error?.message ?? error); }
      cx.notify();
      cx.timer.after(2200, (cx) => { this.savedAt = 0; cx.notify(); });
    });
  }

  saveTasks(patch, cx) {
    cx.spawn(async (cx) => {
      try {
        const next = mergeTaskSetting(this.taskCfg, patch);
        await writeTextFile(taskSettingsPath(home()), JSON.stringify(next, null, 2) + "\n", this.taskRaw);
        this.taskCfg = next;
        this.taskRaw = JSON.stringify(next, null, 2) + "\n";
        this.savedAt = Date.now();
      } catch (error) { this.error = String(error?.message ?? error); }
      cx.notify();
      cx.timer.after(2200, (cx) => { this.savedAt = 0; cx.notify(); });
    });
  }

  ensureIngressInputs() {
    const make = (source) => {
      const adapter = InputState.new({ placeholder: source.adapter ?? "gitlab" });
      const space = InputState.new({ placeholder: "space (optional)" });
      const secret = InputState.new({ placeholder: "secret env name" });
      const map = InputState.new({ placeholder: "repo=space, repo=space" });
      adapter.set_value(source.adapter ?? "");
      space.set_value(source.space ?? "");
      secret.set_value(source.secret_env ?? "");
      map.set_value(Object.entries(source.space_map ?? {}).map(([key, value]) => `${key}=${value}`).join(", "));
      return { adapter, space, secret, map };
    };
    for (const [name, source] of Object.entries(this.ingressCfg.sources ?? {})) {
      if (this.sourceInputs[name]) continue;
      const inputs = make(source);
      inputs.adapter.on("blur", (_e, cx) => this.saveSource(name, { adapter: inputs.adapter.content().text.trim() }, cx));
      inputs.space.on("blur", (_e, cx) => this.saveSource(name, { space: inputs.space.content().text.trim() }, cx));
      inputs.secret.on("blur", (_e, cx) => this.saveSource(name, { secret_env: inputs.secret.content().text.trim() }, cx));
      inputs.map.on("blur", (_e, cx) => {
        const space_map = {};
        for (const part of inputs.map.content().text.split(",")) {
          const [key, value] = part.split("=").map((item) => item.trim());
          if (key && value) space_map[key] = value;
        }
        this.saveSource(name, { space_map }, cx);
      });
      this.sourceInputs[name] = inputs;
    }
    for (const [name, client] of Object.entries(this.ingressCfg.clients ?? {})) {
      if (this.clientInputs[name]) continue;
      const token = InputState.new({ placeholder: "token env name" });
      const space = InputState.new({ placeholder: "space" });
      token.set_value(client.token_env ?? "");
      space.set_value(client.space ?? "");
      token.on("blur", (_e, cx) => this.saveClient(name, { token_env: token.content().text.trim() }, cx));
      space.on("blur", (_e, cx) => this.saveClient(name, { space: space.content().text.trim() }, cx));
      this.clientInputs[name] = { token, space };
    }
  }

  saveSource(name, patch, cx) {
    const sources = { ...(this.ingressCfg.sources ?? {}) };
    sources[name] = { ...(sources[name] ?? {}), ...patch };
    this.saveIngress({ sources }, cx);
  }

  saveClient(name, patch, cx) {
    const clients = { ...(this.ingressCfg.clients ?? {}) };
    clients[name] = { ...(clients[name] ?? {}), ...patch };
    this.saveIngress({ clients }, cx);
  }

  addSource(cx) {
    const name = this.newSource.content().text.trim();
    if (!name) return;
    const sources = { ...(this.ingressCfg.sources ?? {}) };
    if (sources[name]) return;
    sources[name] = { adapter: name, enabled: true };
    this.ingressCfg = { ...this.ingressCfg, sources };
    this.ensureIngressInputs();
    this.saveIngress({ sources }, cx);
    this.newSource.set_value("");
  }

  field(t, label, state) {
    return v_flex().gap(3).py(7).child(div().text_size(TEXT.label).text_color(t.dim).child(label))
      .child(div().w(320).child(Input.new(state)));
  }

  sourceCard(t, name, source) {
    const inputs = this.sourceInputs[name];
    return v_flex().w_full().py(10).border_b(1).border_color(t.border)
      .child(h_flex().w_full().items_center().gap(10)
        .child(div().flex_1().text_size(TEXT.body).font_medium().text_color(t.foreground).child(name))
        .child(segmented(`ingress-source-${name}`, [["off", "Off"], ["on", "On"]], source.enabled === false ? "off" : "on",
          (v, _e, cx) => this.setSourceEnabled(name, v === "on", cx))))
      .when(Boolean(inputs), (el) => el
        .child(this.field(t, "Adapter", inputs.adapter))
        .child(this.field(t, "Default space", inputs.space))
        .child(this.field(t, "Secret env", inputs.secret))
        .child(this.field(t, "Space map", inputs.map)));
  }

  clientCard(t, name, client) {
    const inputs = this.clientInputs[name];
    return v_flex().w_full().py(10).border_b(1).border_color(t.border)
      .child(h_flex().w_full().items_center().gap(10)
        .child(div().flex_1().text_size(TEXT.body).font_medium().text_color(t.foreground).child(name))
        .child(segmented(`ingress-client-${name}`, [["off", "Off"], ["on", "On"]], client.enabled === false ? "off" : "on",
          (v, _e, cx) => this.setClientEnabled(name, v === "on", cx))))
      .when(Boolean(inputs), (el) => el
        .child(this.field(t, "Token env", inputs.token))
        .child(this.field(t, "Space", inputs.space)));
  }

  saveIngress(patch, cx) {
    cx.spawn(async (cx) => {
      try {
        const path = `${home()}/.config/collie/sources.json`;
        const next = {
          ...this.ingressCfg,
          sources: { ...(this.ingressCfg.sources ?? {}) },
          clients: { ...(this.ingressCfg.clients ?? {}) },
          ...patch,
        };
        await writeTextFile(path, JSON.stringify(next, null, 2) + "\n", this.ingressRaw);
        this.ingressCfg = next;
        this.ingressRaw = JSON.stringify(next, null, 2) + "\n";
        this.savedAt = Date.now();
      } catch (error) { this.error = String(error?.message ?? error); }
      cx.notify();
      cx.timer.after(2200, (cx) => { this.savedAt = 0; cx.notify(); });
    });
  }

  setSourceEnabled(name, enabled, cx) {
    const sources = { ...(this.ingressCfg.sources ?? {}) };
    sources[name] = { ...(sources[name] ?? {}), enabled };
    this.saveIngress({ sources }, cx);
  }

  setClientEnabled(name, enabled, cx) {
    const clients = { ...(this.ingressCfg.clients ?? {}) };
    clients[name] = { ...(clients[name] ?? {}), enabled };
    this.saveIngress({ clients }, cx);
  }

  close() { closeOverlay(props().overlay); }

  row(t, title, about, control, under = null) {
    return v_flex().w_full().gap(10).py(12).border_b(1).border_color(t.border)
      .child(h_flex().w_full().gap(16).items_center()
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(div().text_size(TEXT.body).font_medium().text_color(t.foreground).child(title))
          .child(div().text_size(TEXT.label).line_height("17px").text_color(t.dim).child(about))
          .when(Boolean(under), (el) => el.child(under)))
        .child(div().flex_none().child(control)));
  }

  heading(t, title, about = null) {
    return v_flex().pb(8).gap(4)
      .child(div().text_size(TEXT.title).font_semibold().text_color(t.foreground).child(title))
      .when(Boolean(about), (el) => el.child(div().text_size(TEXT.label).text_color(t.dim).child(about)));
  }

  levelBar(t) {
    const own = Object.keys(this.cfg.spaces ?? {}).length;
    return v_flex().pb(18).gap(6)
      .child(h_flex().gap(10).items_center()
        .child(div().text_size(TEXT.label).text_color(t.dim).child("Applies to"))
        .child(div().h(H.sm).px(10).flex().items_center().rounded(RADIUS.control).bg(t.raised)
          .text_size(TEXT.label).text_color(t.foreground).child("Everywhere")))
      .child(div().text_size(TEXT.label).text_color(t.dim)
        .child(own ? `Inherited unless one of ${own} space(s) sets its own.` : "Every space, unless it sets its own."));
  }

  coordinator(t) {
    const current = this.cfg.everywhere?.coordinator ?? {};
    return v_flex()
      .child(this.heading(t, "Coordinator", "The chat and decision role. New sessions inherit these defaults."))
      .child(this.row(t, "Agent", "CLI used for Coordinator chat and ingress decisions.",
        segmented("coordinator-agent", AGENTS, current.cli ?? "claude", (cli, _e, cx) => this.saveCoordinator({ cli }, cx))))
      .child(this.row(t, "Model", "CLI default, or a model id for this role.",
        div().w(220).child(Input.new(this.model)), this.saved()))
      .child(this.row(t, "Effort", "How much reasoning the Coordinator spends on each decision.",
        segmented("coordinator-effort", EFFORTS, current.effort ?? "high", (effort, _e, cx) => this.saveCoordinator({ effort }, cx), { size: "lg" })))
      .child(this.row(t, "Permission", "Default permission mode for new Coordinator sessions.",
        segmented("coordinator-perm", [["auto", "Auto"], ["manual", "Ask"], ["acceptEdits", "Accept edits"]], current.perm ?? "auto",
          (perm, _e, cx) => this.saveCoordinator({ perm }, cx))));
  }

  roleEditor(t, role, title, about) {
    const current = this.taskCfg[role] ?? {};
    const model = role === "worker" ? this.workerModel : this.reviewerModel;
    return v_flex()
      .child(this.heading(t, title, about))
      .child(this.row(t, "Agent", "CLI used for this role; task-level selection can override it.",
        segmented(`${role}-agent`, AGENTS, current.agent ?? "claude", (agent, _e, cx) => this.saveRole(role, { agent }, cx))))
      .child(this.row(t, "Model", "CLI default, or a model id for this role.",
        div().w(220).child(Input.new(model)), this.saved()))
      .child(this.row(t, "Effort", "Default reasoning effort for this role.",
        segmented(`${role}-effort`, EFFORTS, current.effort ?? "high", (effort, _e, cx) => this.saveRole(role, { effort }, cx), { size: "lg" })));
  }

  worker(t) {
    const rounds = this.taskCfg.tasks?.review_rounds;
    return this.roleEditor(t, "worker", "Worker", "Task execution role. Settings apply to newly started workers.")
      .child(this.row(t, "Review", "Review is enabled per task; this is the default number of rounds.",
        segmented("worker-review-rounds", [["0", "Off"], ["1", "1"], ["2", "2"], ["3", "3"]], String(rounds ?? 0),
          (value, _e, cx) => this.saveTasks({ review_rounds: Number(value) }, cx))));
  }

  reviewer(t) {
    return this.roleEditor(t, "reviewer", "Reviewer", "Review role. A task gets one when review is enabled.")
      .child(this.row(t, "Must fix", "Lowest review finding that blocks Ready.",
        segmented("reviewer-must-fix", [["blocker", "Blocker"], ["major", "Major"], ["minor", "Minor"]], this.taskCfg.tasks?.must_fix ?? "major",
          (must_fix, _e, cx) => this.saveTasks({ must_fix }, cx))));
  }

  helper(t) {
    return v_flex()
      .child(this.heading(t, "Helper", "The persistent ingress session is not a separate role."))
      .child(this.row(t, "Agent", "The Helper uses the Coordinator role's agent and template; it is always kept alive.", div()))
      .child(this.row(t, "Prompt", "Role template: collie-coordinator.md; helper jobs add the Decision contract.",
        div().text_size(TEXT.label).text_color(t.dim).child("Read-only")));
  }

  spacesSection(t) {
    const list = spaces();
    return v_flex()
      .child(this.heading(t, "Spaces", "Workspace and folder mapping. Role overrides stay under Roles."))
      .when(!list.length, (el) => el.child(div().py(12).text_size(TEXT.label).text_color(t.dim).child("No live spaces.")))
      .children(list.map((space) => this.row(t, space.name ?? space.id,
        `${space.folder ?? "no folder"}${space.machine ? ` · ${space.machine}` : ""}`,
        div().text_size(TEXT.label).text_color(t.dim).child("Read-only"))));
  }

  diagnostics(t) {
    return v_flex()
      .child(this.heading(t, "Diagnostics", "Paths and service state; runtime data is not editable here."))
      .child(this.row(t, "Config directory", "Coordinator, roles, ingress and workspace configuration.",
        div().text_size(TEXT.label).text_color(t.dim).child("~/.config/collie")))
      .child(this.row(t, "State directory", "Ledger, queue, ingress snapshot, helper jobs and sockets.",
        div().text_size(TEXT.label).text_color(t.dim).child("~/.local/state/collie")))
      .child(this.row(t, "Event ingress", "Native POST /v1/ingress and vendor POST /v1/in/<source>.",
        div().text_size(TEXT.label).text_color(t.dim).child("service.sock")));
  }

  ingress(t) {
    const sources = Object.entries(this.ingressCfg.sources ?? {});
    const clients = Object.entries(this.ingressCfg.clients ?? {});
    return v_flex()
      .child(this.heading(t, "Ingress", "Native Collie Event clients and vendor webhook adapters."))
      .child(this.row(t, "Native clients", "Clients that already speak the Collie Event contract; use /v1/ingress.",
        div().text_size(TEXT.label).text_color(t.dim).child("Unix socket / TCP")))
      .when(Boolean(clients.length), (el) => el.child(v_flex().py(4).children(clients.map(([name, client]) => this.clientCard(t, name, client)))))
      .child(this.row(t, "Vendor sources", "Webhook adapters for GitLab/GitHub-style payloads; use /v1/in/<source>.",
        div().text_size(TEXT.label).text_color(t.dim).child("Adapter + space map")))
      .when(Boolean(sources.length), (el) => el.child(v_flex().py(4).children(sources.map(([name, source]) => this.sourceCard(t, name, source)))))
      .child(h_flex().pt(12).gap(8).items_center()
        .child(div().w(180).child(Input.new(this.newSource)))
        .child(button("ingress-add-source", "Add source", { kind: "secondary", onClick: (_e, cx) => this.addSource(cx) })));
  }

  navItem(t, id, label, icon = null) {
    const on = this.section === id;
    return h_flex().id(`collie-settings-${id}`).h(30).gap(8).px(8).flex_none().items_center().rounded(RADIUS.card)
      .when(on, (el) => el.bg(t.raised))
      .cursor_pointer().hover((s) => s.bg(on ? t.raised : t.hover))
      .on_click((_e, cx) => { this.section = id; cx.notify(); })
      .when(Boolean(icon), (el) => el.child(svg(icon).size(14).text_color(on ? t.accent : t.dim)))
      .child(div().flex_1().text_size(TEXT.body).text_color(on ? t.foreground : t.muted).child(label));
  }

  body(t) {
    if (this.section === "coordinator") return this.levelBar(t).child(this.coordinator(t));
    if (this.section === "worker") return this.levelBar(t).child(this.worker(t));
    if (this.section === "reviewer") return this.levelBar(t).child(this.reviewer(t));
    if (this.section === "helper") return this.helper(t);
    if (this.section === "ingress") return this.ingress(t);
    if (this.section === "spaces") return this.spacesSection(t);
    if (this.section === "diagnostics") return this.diagnostics(t);
    return div();
  }

  render(_cx) {
    const t = theme();
    const nav = v_flex().flex_none().w(190).h_full().p(10).gap(2).border_r(1).border_color(t.border)
      .child(div().px(8).pt(6).pb(10).text_size(TEXT.title).font_semibold().text_color(t.foreground).child("Collie"))
      .child(div().px(8).pt(6).pb(4).text_size(TEXT.label).font_medium().text_color(t.dim).child("Roles"))
      .child(this.navItem(t, "coordinator", "Coordinator", sectionIcon))
      .child(this.navItem(t, "worker", "Worker"))
      .child(this.navItem(t, "reviewer", "Reviewer"))
      .child(this.navItem(t, "helper", "Helper"))
      .child(div().px(8).pt(14).pb(4).text_size(TEXT.label).font_medium().text_color(t.dim).child("Connections"))
      .child(this.navItem(t, "ingress", "Ingress", "mods/collie-chrome/network.svg"))
      .child(div().px(8).pt(14).pb(4).text_size(TEXT.label).font_medium().text_color(t.dim).child("Workspace"))
      .child(this.navItem(t, "spaces", "Spaces"))
      .child(div().px(8).pt(14).pb(4).text_size(TEXT.label).font_medium().text_color(t.dim).child("System"))
      .child(this.navItem(t, "diagnostics", "Diagnostics"));
    const card = h_flex().id("collie-settings").track_focus(this.handle).w_full().h_full().max_h(900).min_h(0).items_start()
      .rounded(12).border_1().border_color(t.border).bg(t.popover).shadow_lg().overflow_hidden()
      .on_click((_e, cx) => cx.stop_propagation())
      .on_key_down((e, cx) => { if (e.key === "escape") this.close(); })
      .child(nav)
      .child(div().relative().flex_1().min_w(0).h_full()
        .child(div().id("collie-settings-body").size_full().overflow_y_scroll()
          .child(div().px(28).py(22)
            .child(this.body(t))
            .when(this.error, (el) => el.child(div().pt(16).text_size(TEXT.label).text_color(t.ansi1).child(this.error)))))
        .child(Scrollbar.vertical("collie-settings-body").absolute().inset_0()));
    return div().id("collie-settings-root").size_full().flex().items_center().justify_center()
      .on_click(() => this.close()).child(card);
  }
}
