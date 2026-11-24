import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { appHome, closeOverlay, exec, home, props, readTextFile, spaces, theme, writeTextFile } from "herdr";
import { coordinatorPath, mergeCoordinator, mergeRole, mergeTaskSetting, taskSettingsPath } from "./lib/inbox-settings.js";
import { blankPlaybookText, blankRoleText, configDirectory, definitionFile } from "./lib/definition-files.js";
import { TEXT, RADIUS, H, button, segmented, menuRow, dialogFooter } from "./lib/ui.js";

const sectionIcon = "mods/collie-chrome/network.svg";

const EFFORTS = [["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "XHigh"], ["max", "Max"]];
const AGENTS = [["claude", "Claude"], ["codex", "Codex"]];

export default class InboxSettings extends View {
  init(_props, cx) {
    this.tab = "collaboration";
    this.section = "coordinator";
    this.cfg = {};
    this.raw = null;
    this.ingressCfg = {};
    this.ingressRaw = null;
    this.taskCfg = {};
    this.taskRaw = null;
    this.roles = [];
    this.playbooks = [];
    this.picks = {};
    this.menu = null;
    this.savedAt = 0;
    this.doc = null;
    this.definitionError = null;
    this.viewTab = "prompt";
    this.confirmDelete = false;
    this.fileEditor = TextareaState.new({ placeholder: "frontmatter + prompt", rows: 22 });
    this.fileNameInput = InputState.new({ placeholder: "role.md" });
    this.runnerRole = null;
    this.runnerModel = InputState.new({ placeholder: "CLI default" });
    this.model = InputState.new({ placeholder: "CLI default" });
    this.sourceInputs = {};
    this.clientInputs = {};
    this.newSource = InputState.new({ placeholder: "source name" });
    this.model.on("blur", (_e, cx) => this.saveCoordinator({ model: this.model.content().text.trim() }, cx));
    this.runnerModel.on("blur", (_e, cx) => {
      if (this.runnerRole) this.saveRole(this.runnerRole, { model: this.runnerModel.content().text.trim() }, cx);
    });
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
    try {
      const result = await exec(`${appHome()}/bin/collie`, ["roles", "list"]);
      const catalog = JSON.parse(result.stdout || "{}");
      this.roles = Array.isArray(catalog.roles) ? catalog.roles : [];
      this.playbooks = Array.isArray(catalog.playbooks) ? catalog.playbooks : [];
    } catch {
      this.roles = [
        { name: "coordinator", description: "判断、选择 playbook、分发 Ticket/Task", origin: "system" },
        { name: "driver", description: "按 playbook 编排 task", origin: "system" },
      ];
    }
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

  roleSummary(t, id) {
    const text = id === "coordinator" ? {
      purpose: "负责看消息、判断下一步，并把要做的事交给执行的人。",
      duties: ["看外部消息或你的话", "判断是新建事情、继续已有事情，还是先问你", "把要做的事交给负责执行的人", "需要你决定时向你确认"],
      not: ["不直接写代码", "不审查、不验证", "不替你接受结果"],
    } : id === "driver" ? {
      purpose: "负责把一件任务做完，并按需要找其他人帮忙。",
      duties: ["读懂任务说明和工作方式", "自己完成，或找适合的人协作", "把结果整理好交回来"],
      not: ["不修改系统规则", "不替你做最终决定", "不跨项目协调"],
    } : null;
    if (!text) return v_flex();
    const list = (items) => v_flex().gap(3).children(items.map((item) => h_flex().gap(6).items_start()
      .child(div().w(8).flex_none().text_size(TEXT.label).text_color(t.dim).child("•"))
      .child(div().flex_1().text_size(TEXT.label).line_height("17px").text_color(t.muted).child(item))));
    return v_flex().pb(12).gap(6)
      .child(div().text_size(TEXT.label).line_height("17px").text_color(t.muted).child(text.purpose))
      .child(v_flex().gap(3).child(div().text_size(TEXT.label).font_medium().text_color(t.foreground).child("它负责"))
        .child(list(text.duties)))
      .child(v_flex().gap(3).child(div().text_size(TEXT.label).font_medium().text_color(t.foreground).child("它不负责"))
        .child(list(text.not)));
  }

  coordinator(t) {
    const current = this.cfg.everywhere?.coordinator ?? {};
    return v_flex()
      .child(this.heading(t, "Coordinator", "系统固定，不能改；这里只调整它怎么运行。"))
      .child(this.roleSummary(t, "coordinator"))
      .child(this.row(t, "工具", "运行 Coordinator 时使用的工具。",
        segmented("coordinator-agent", AGENTS, current.cli ?? "claude", (cli, _e, cx) => this.saveCoordinator({ cli }, cx))))
      .child(this.row(t, "模型", "使用工具默认模型，或指定一个模型。",
        div().w(220).child(Input.new(this.model)), this.saved()))
      .child(this.row(t, "思考强度", "每次判断时投入多少思考。",
        segmented("coordinator-effort", EFFORTS, current.effort ?? "high", (effort, _e, cx) => this.saveCoordinator({ effort }, cx), { size: "lg" })))
      .child(this.row(t, "权限", "Coordinator 默认可以做什么。",
        segmented("coordinator-perm", [["auto", "Auto"], ["manual", "Ask"], ["acceptEdits", "Accept edits"]], current.perm ?? "auto",
          (perm, _e, cx) => this.saveCoordinator({ perm }, cx))));
  }

  syncRunner(roleId) {
    this.runnerRole = roleId;
    this.runnerModel.set_value(this.taskCfg[roleId]?.model ?? "");
  }

  runnerRows(t, role) {
    const current = this.taskCfg[role] ?? {};
    return v_flex()
      .child(this.row(t, "工具", "执行这个角色时使用的工具。",
        segmented(`${role}-agent`, AGENTS, current.agent ?? "claude", (agent, _e, cx) => this.saveRole(role, { agent }, cx))))
      .child(this.row(t, "模型", "使用工具默认模型，或指定一个模型。",
        div().w(220).child(Input.new(this.runnerModel)), this.saved()))
      .child(this.row(t, "思考强度", "执行这个角色时投入多少思考。",
        segmented(`${role}-effort`, EFFORTS, current.effort ?? "high", (effort, _e, cx) => this.saveRole(role, { effort }, cx), { size: "lg" })));
  }

  driver(t) {
    const rounds = this.taskCfg.tasks?.review_rounds;
    return v_flex()
      .child(this.heading(t, "Driver", "系统固定，不能改；这里只调整它怎么运行。"))
      .child(this.roleSummary(t, "driver"))
      .child(this.runnerRows(t, "driver"))
      .child(this.row(t, "检查轮次", "每个任务默认检查几轮。",
        segmented("driver-review-rounds", [["0", "Off"], ["1", "1"], ["2", "2"], ["3", "3"]], String(rounds ?? 0),
          (value, _e, cx) => this.saveTasks({ review_rounds: Number(value) }, cx))));
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

  topTab(t, id, label) {
    const on = this.tab === id;
    return div().id(`collie-settings-tab-${id}`).h(30).px(12).flex().items_center().rounded(RADIUS.card)
      .when(on, (el) => el.bg(t.raised))
      .cursor_pointer().hover((s) => s.bg(on ? t.raised : t.hover))
      .on_click((_e, cx) => {
        this.tab = id;
        this.section = id === "collaboration" ? "coordinator" : id === "connections" ? "ingress" : id === "workspace" ? "spaces" : "diagnostics";
        cx.notify();
      })
      .child(div().text_size(TEXT.body).text_color(on ? t.foreground : t.muted).child(label));
  }

  sidebar(t) {
    const item = (id, label, badge = null) => this.navItem(t, id, label, null, badge);
    if (this.tab === "connections") return v_flex().flex_none().w(190).h_full().p(10).gap(2).border_r(1).border_color(t.border).children([item("ingress", "Ingress")]);
    if (this.tab === "workspace") return v_flex().flex_none().w(190).h_full().p(10).gap(2).border_r(1).border_color(t.border).children([item("spaces", "Spaces")]);
    if (this.tab === "system") return v_flex().flex_none().w(190).h_full().p(10).gap(2).border_r(1).border_color(t.border).children([item("diagnostics", "Diagnostics")]);
    return v_flex().flex_none().w(190).h_full().p(10).gap(2).border_r(1).border_color(t.border)
      .child(div().px(8).pt(6).pb(4).text_size(TEXT.label).font_medium().text_color(t.dim).child("System"))
      .child(item("coordinator", "Coordinator"))
      .child(item("driver", "Driver"))
      .child(div().h(1).mx(8).my(6).bg(t.border))
      .child(div().px(8).pt(2).pb(4).text_size(TEXT.label).font_medium().text_color(t.dim).child("User"))
      .child(item("roles", "Roles"))
      .child(item("playbooks", "Playbooks"));
  }

  definitionFiles(kind) {
    return (kind === "roles" ? this.roles : this.playbooks).filter((item) => item.origin === "config").map((item) => item.file);
  }

  definitionDirectory(kind) {
    const first = this.definitionFiles(kind)[0];
    return first ? first.slice(0, first.lastIndexOf("/")) : `${home()}/.config/collie/${kind}`;
  }

  fileName(file) { return file?.split("/").at(-1) ?? ""; }

  openDefinition(kind, file, cx) {
    this.picks[kind] = file;
    this.menu = null;
    this.definitionError = null;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(file);
        if (text === null) throw new Error("file disappeared");
        const role = kind === "roles" ? this.roles.find((item) => item.file === file) : null;
        this.fileEditor.set_value(text);
        this.fileNameInput.set_value(this.fileName(file));
        this.viewTab = kind === "roles" ? "runner" : "prompt";
        this.confirmDelete = false;
        this.doc = { kind, file, original: text, roleId: role?.name ?? null };
        if (role) this.syncRunner(role.name);
      } catch (error) { this.definitionError = String(error?.message ?? error); }
      cx.notify();
    });
  }

  // New is one file: a valid template is written, the service reloads it, and the whole file opens.
  createNewDefinition(kind, cx) {
    cx.spawn(async (cx) => {
      try {
        const dir = configDirectory(home(), kind);
        const base = kind === "roles" ? "role" : "playbook";
        const taken = new Set((kind === "roles" ? this.roles : this.playbooks).map((item) => item.name));
        let n = 1, id = `${base}-${n}`, path = definitionFile(home(), kind, id);
        while (taken.has(id) || await readTextFile(path) !== null) {
          n += 1;
          id = `${base}-${n}`;
          path = definitionFile(home(), kind, id);
        }
        await exec("mkdir", ["-p", dir]);
        await writeTextFile(path, kind === "roles" ? blankRoleText(id) : blankPlaybookText(id), null);
        const reloaded = await exec(`${appHome()}/bin/collie`, ["roles", "reload"]);
        if (reloaded.code !== 0) throw new Error((reloaded.stderr || reloaded.stdout || "reload failed").trim());
        await this.load();
        this.viewTab = kind === "roles" ? "runner" : "prompt";
        this.confirmDelete = false;
        this.openDefinition(kind, path, cx);
        this.savedAt = Date.now();
        cx.timer.after(2200, (cx) => { this.savedAt = 0; cx.notify(); });
      } catch (error) { this.definitionError = String(error?.message ?? error); }
      cx.notify();
    });
  }

  editorTab(t, id, label, on, cx) {
    return h_flex().id(`definition-tab-${id}`).h(30).px(12).gap(6).items_center().rounded(RADIUS.card).cursor_pointer()
      .text_size(TEXT.body).when(on, (el) => el.bg(t.raised).text_color(t.foreground).font_medium())
      .when(!on, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click((e, c) => { c.stop_propagation(); this.viewTab = id; c.notify(); })
      .child(label);
  }

  requestDelete(cx) {
    if (!this.doc) return;
    this.confirmDelete = true;
    cx.notify();
  }

  deleteDefinition(cx) {
    const doc = this.doc;
    if (!doc) return;
    this.confirmDelete = false;
    cx.spawn(async (cx) => {
      try {
        const removed = await exec("rm", [doc.file]);
        if (removed.code !== 0) throw new Error((removed.stderr || removed.stdout || "delete failed").trim());
        this.doc = null;
        delete this.picks[doc.kind];
        this.fileEditor.set_value("");
        this.fileNameInput.set_value("");
        const reloaded = await exec(`${appHome()}/bin/collie`, ["roles", "reload"]);
        if (reloaded.code !== 0) throw new Error((reloaded.stderr || reloaded.stdout || "reload failed").trim());
        await this.load();
        this.definitionError = null;
        this.savedAt = Date.now();
        cx.timer.after(2200, (cx) => { this.savedAt = 0; cx.notify(); });
      } catch (error) { this.definitionError = String(error?.message ?? error); }
      cx.notify();
    });
  }

  deleteConfirm(t, cx) {
    const doc = this.doc;
    if (!doc) return div();
    const noun = doc.kind === "roles" ? "role" : "playbook";
    return div().absolute().inset_0().flex().items_center().justify_center().bg(t.background)
      .on_click((_e, c) => { c.stop_propagation(); this.confirmDelete = false; c.notify(); })
      .child(v_flex().id("delete-confirm").w(440).rounded(12).border_1().border_color(t.border).bg(t.popover).p(18).gap(8)
        .on_click((_e, c) => c.stop_propagation())
        .child(div().text_size(TEXT.title).font_semibold().text_color(t.foreground).child(`Delete ${noun}?`))
        .child(div().text_size(TEXT.label).line_height("18px").text_color(t.muted)
          .child(`This removes ${this.fileName(doc.file)} from ~/.config/collie/${doc.kind}. It cannot be undone.`))
        .child(div().h(8))
        .child(dialogFooter({
          onCancel: (_e, cx) => { this.confirmDelete = false; cx.notify(); },
          primary: { id: "delete-confirm-yes", label: `Delete ${noun}`, onClick: (_e, cx) => this.deleteDefinition(cx) },
        })));
  }

  definitionEditor(t, kind, cx) {
    const doc = this.doc;
    if (!doc || doc.kind !== kind) return v_flex().pt(14).text_size(TEXT.label).text_color(t.dim)
      .child(`选择一个 ${kind === "roles" ? "role" : "playbook"}，或新建一个。`);
    const showRunner = kind === "roles" && Boolean(doc.roleId) && this.viewTab !== "prompt";
    const active = showRunner ? "runner" : "prompt";
    return v_flex().w_full().pt(14).gap(10)
      .child(h_flex().w_full().items_center().gap(8)
        .child(div().w(300).h(H.sm).flex_none().px(6).flex().items_center().rounded(RADIUS.control)
          .hover((s) => s.bg(t.hover)).child(Input.new(this.fileNameInput)))
        .child(div().flex_1())
        .when(Boolean(this.savedAt), (el) => el.child(this.saved()))
        .child(button("definition-delete", "Delete", { kind: "secondary", onClick: (_e, cx) => this.requestDelete(cx) }))
        .child(button("definition-cancel", "Cancel", { kind: "plain", onClick: (_e, cx) => { this.doc = null; this.definitionError = null; this.confirmDelete = false; cx.notify(); } }))
        .child(button("definition-save", "Save", { kind: "primary", onClick: (_e, cx) => this.saveDefinition(cx) })))
      .child(v_flex().gap(0)
        .child(h_flex().h(34).gap(2).items_end()
          .when(kind === "roles", (el) => el.child(this.editorTab(t, "runner", "Runner", active === "runner", cx)))
          .child(this.editorTab(t, "prompt", "Prompt", active === "prompt", cx)))
        .child(div().h(1).flex_none().mt(6).bg(t.border)))
      .when(active === "runner", (el) => el.child(v_flex().pt(12).pb(20)
        .child(this.runnerRows(t, doc.roleId))))
      .when(active === "prompt", (el) => el.child(v_flex().pt(12).pb(20)
        .child(div().w_full().rounded(RADIUS.card).border_1().border_color(t.input).bg(t.background).p(8)
          .child(Textarea.new(this.fileEditor).w_full().h(440).text_size(TEXT.body)))))
      .when(this.definitionError, (el) => el.child(div().pt(2).text_size(TEXT.label).text_color(t.ansi1).child(this.definitionError)));
  }

  saveDefinition(cx) {
    const doc = this.doc;
    if (!doc) return;
    const text = this.fileEditor.value();
    let name = this.fileNameInput.content().text.trim();
    if (name && !name.endsWith(".md")) name += ".md";
    cx.spawn(async (cx) => {
      try {
        if (!text.trim()) throw new Error("文件不能为空");
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(name) || name.includes("..")) {
          throw new Error("文件名只能包含字母、数字、点、-、_，并以 .md 结尾");
        }
        const dir = doc.file.slice(0, doc.file.lastIndexOf("/"));
        let file = doc.file;
        const next = `${dir}/${name}`;
        if (next !== file) {
          if (await readTextFile(next) !== null) throw new Error(`${name} already exists`);
          await exec("mv", [file, next]);
          file = next;
          // The move happened; keep the editor pointed at it even if the following write fails.
          this.doc = { ...this.doc, file };
          this.picks[doc.kind] = file;
        }
        await writeTextFile(file, text, doc.original);
        this.doc = { ...this.doc, file, original: text };
        this.fileNameInput.set_value(name);
        const reloaded = await exec(`${appHome()}/bin/collie`, ["roles", "reload"]);
        if (reloaded.code !== 0) throw new Error((reloaded.stderr || reloaded.stdout || "reload failed").trim());
        await this.load();
        const role = doc.kind === "roles" ? this.roles.find((item) => item.file === file) : null;
        this.doc = { ...this.doc, roleId: role?.name ?? null };
        if (role) this.syncRunner(role.name);
        this.definitionError = null;
        this.savedAt = Date.now();
        cx.timer.after(2200, (cx) => { this.savedAt = 0; cx.notify(); });
      } catch (error) { this.definitionError = String(error?.message ?? error); }
      cx.notify();
    });
  }

  filePicker(t, kind, files, cx) {
    const key = kind;
    const picked = this.picks[key];
    const title = kind === "roles" ? "Roles" : "Playbooks";
    const open = this.menu === key;
    return v_flex().gap(6).py(10).border_b(1).border_color(t.border)
      .child(h_flex().gap(10).items_center()
        .child(div().w(120).flex_none().text_size(TEXT.body).font_medium().text_color(t.foreground).child(title))
        .child(div().flex_1().min_w(0).text_size(TEXT.label).text_color(t.dim).child(this.definitionDirectory(kind)))
        .child(h_flex().id(`pick-${key}`).h(H.sm).px(8).gap(6).items_center().rounded(RADIUS.control).border_1().border_color(t.input).bg(t.background).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click((_e, c) => { c.stop_propagation(); this.menu = open ? null : key; c.notify(); })
          .child(div().min_w(110).max_w(220).truncate().text_size(TEXT.label).text_color(picked ? t.foreground : t.dim).child(picked ? this.fileName(picked) : "Select file"))
          .child(svg("mods/collie-chrome/chevron-down.svg").size(12).text_color(t.dim)))
        .child(button(`new-${key}`, "New", { kind: "secondary", onClick: (_e, c) => this.createNewDefinition(kind, c) })))
      .when(open, (el) => el.child(v_flex().w_full().p(4).rounded(RADIUS.card).border_1().border_color(t.border).bg(t.popover)
        .when(!files.length, (x) => x.child(div().px(8).py(6).text_size(TEXT.label).text_color(t.dim).child("没有可显示的文件。")))
        .children(files.map((file) => menuRow(`pick-${key}-${file}`, this.fileName(file), { check: picked === file, onClick: (_e, c) => {
          this.openDefinition(kind, file, c); c.notify();
        } })))));
  }

  definitionPage(t, kind, cx) {
    const title = kind === "roles" ? "Roles" : "Playbooks";
    const label = kind === "roles" ? "角色" : "工作流程";
    return v_flex()
      .child(this.heading(t, title, `用户级${label}全部存放在 ~/.config/collie/${kind}；可以直接编辑或新建。`))
      .child(this.filePicker(t, kind, this.definitionFiles(kind), cx))
      .child(this.definitionEditor(t, kind, cx));
  }

  navItem(t, id, label, icon = null, badge = null) {
    const on = this.section === id;
    return h_flex().id(`collie-settings-${id}`).h(30).gap(8).px(8).flex_none().items_center().rounded(RADIUS.card)
      .when(on, (el) => el.bg(t.raised))
      .cursor_pointer().hover((s) => s.bg(on ? t.raised : t.hover))
      .on_click((_e, cx) => {
        this.section = id;
        if (id === "driver") this.syncRunner("driver");
        if (id === "roles" && this.doc?.kind === "roles" && this.doc.roleId) this.syncRunner(this.doc.roleId);
        cx.notify();
      })
      .when(Boolean(icon), (el) => el.child(svg(icon).size(14).text_color(on ? t.accent : t.dim)))
      .child(div().flex_1().text_size(TEXT.body).text_color(on ? t.foreground : t.muted).child(label))
      .when(Boolean(badge), (el) => el.child(div().h(16).px(5).flex().items_center().rounded(4).bg(t.raised).text_size(10).text_color(t.dim).child(badge)));
  }

  body(t) {
    if (this.section === "roles") return this.definitionPage(t, "roles", this._cx);
    if (this.section === "playbooks") return this.definitionPage(t, "playbooks", this._cx);
    if (this.section === "coordinator") return this.coordinator(t);
    if (this.section === "driver") return this.driver(t);
    if (this.section === "ingress") return this.ingress(t);
    if (this.section === "spaces") return this.spacesSection(t);
    if (this.section === "diagnostics") return this.diagnostics(t);
    return div();
  }

  render(_cx) {
    this._cx = _cx;
    const t = theme();
    const nav = this.sidebar(t);
    const tabs = h_flex().flex_none().h(42).px(12).gap(4).items_center().border_b_1().border_color(t.border)
      .child(div().px(8).text_size(TEXT.title).font_semibold().text_color(t.foreground).child("Collie"))
      .child(this.topTab(t, "collaboration", "协作模式"))
      .child(this.topTab(t, "connections", "连接"))
      .child(this.topTab(t, "workspace", "工作区"))
      .child(this.topTab(t, "system", "系统"));
    const content = div().relative().flex_1().min_w(0).h_full()
      .child(div().id("collie-settings-body").size_full().overflow_y_scroll()
        .child(div().px(28).py(22)
          .child(this.body(t))
          .when(this.error, (el) => el.child(div().pt(16).text_size(TEXT.label).text_color(t.ansi1).child(this.error)))))
      .child(Scrollbar.vertical("collie-settings-body").absolute().inset_0());
    const card = v_flex().id("collie-settings").track_focus(this.handle).w_full().h_full().max_h(900).min_h(0)
      .rounded(12).border_1().border_color(t.border).bg(t.popover).shadow_lg().overflow_hidden()
      .on_click((_e, cx) => cx.stop_propagation())
      .on_key_down((e, cx) => { if (e.key === "escape") this.close(); })
      .child(tabs)
      .child(h_flex().flex_1().min_h(0).items_start().child(nav).child(content));
    return div().id("collie-settings-root").relative().size_full().flex().items_center().justify_center()
      .on_click(() => this.close()).child(card)
      .when(this.confirmDelete, (el) => el.child(this.deleteConfirm(t, _cx)));
  }
}
