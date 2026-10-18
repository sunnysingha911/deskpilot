// deskpilot control panel. Plain DOM; every dynamic value goes through textContent, never innerHTML,
// because run output contains untrusted screen/web content.

// ── Token + API ──────────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
if (params.get("t")) {
  sessionStorage.setItem("deskpilot-token", params.get("t"));
  history.replaceState(null, "", location.pathname + location.hash);
}
const TOKEN = sessionStorage.getItem("deskpilot-token") ?? "";

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "x-deskpilot-token": TOKEN, ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data;
}

// ── DOM helpers ──────────────────────────────────────────────────────────────
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    // CSSOM, not the style attribute: the page's CSP forbids inline style attributes.
    else if (k === "style") el.style.cssText = v;
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const badge = (text, cls = text) => h("span", { class: `badge ${cls}` }, text);
const view = () => document.getElementById("view");
function mount(...nodes) {
  view().replaceChildren(...nodes);
}
let toastTimer;
function toast(msg, isErr = false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = `toast${isErr ? " err" : ""}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isErr ? 7000 : 3000);
}
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : "");
const fmtNum = (n) => Number(n ?? 0).toLocaleString();
const pretty = (v) => {
  if (typeof v === "string") {
    try {
      return JSON.stringify(JSON.parse(v), null, 2);
    } catch {
      return v;
    }
  }
  return JSON.stringify(v, null, 2);
};
function duration(a, b) {
  if (!a) return "";
  const ms = (b ? new Date(b) : new Date()) - new Date(a);
  return ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

// ── Shared state ─────────────────────────────────────────────────────────────
let META = null;
const modelCache = {}; // connection id -> model ids from Test
async function meta() {
  META = await api("GET", "/api/meta");
  return META;
}
const familyOf = (name) => (name.includes(".") ? name.split(".")[0] : name);

// ── Router ───────────────────────────────────────────────────────────────────
let cleanup = () => {};
const routes = [
  [/^#\/run$/, () => viewRun()],
  [/^#\/agents$/, () => viewAgents()],
  [/^#\/agents\/new$/, () => viewAgentEditor(null)],
  [/^#\/agents\/edit\/([a-z0-9-]+)$/, (m) => viewAgentEditor(m[1])],
  [/^#\/agents\/copy\/([a-z0-9-]+)$/, (m) => viewAgentEditor(m[1], true)],
  [/^#\/runs$/, () => viewRuns()],
  [/^#\/runs\/([\w-]+)$/, (m) => viewRunDetail(m[1])],
  [/^#\/providers$/, () => viewProviders()],
  [/^#\/activity$/, () => viewActivity()],
];
async function route() {
  cleanup();
  cleanup = () => {};
  const hash = location.hash || "#/run";
  const section = hash.split("/")[1];
  for (const a of document.querySelectorAll("nav a")) a.classList.toggle("active", a.dataset.nav === section);
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      try {
        await fn(m);
      } catch (err) {
        mount(h("div", { class: "card" }, h("h1", {}, "Something went wrong"), h("p", {}, String(err.message ?? err))));
      }
      return;
    }
  }
  location.hash = "#/run";
}
window.addEventListener("hashchange", route);

async function refreshFoot() {
  try {
    const m = await meta();
    document.getElementById("status-foot").replaceChildren(
      h("div", {}, `OS: ${m.os}`),
      h("div", {}, m.activeRunId ? h("a", { href: `#/runs/${m.activeRunId}` }, "● run in progress") : "idle"),
    );
  } catch (err) {
    document.getElementById("status-foot").textContent = err.message === "missing or wrong token" ? "Reopen via npm run gui" : "server unreachable";
  }
}
setInterval(refreshFoot, 5000);

// ── Timeline (live + history) ────────────────────────────────────────────────
function createTimeline(container, { onEnd } = {}) {
  const toolRows = []; // pending tool_call rows waiting for results, in order
  let currentRunId = null;
  let source = null;
  let count = 0;

  function add(node) {
    container.append(node);
    node.scrollIntoView({ block: "nearest" });
  }

  function render(type, d, runId) {
    count++;
    switch (type) {
      case "start":
        add(h("div", { class: "ev notice" }, h("div", { class: "meta" }, `Run ${d.runId} · ${d.tools.length} tools available`)));
        break;
      case "attempt":
        add(h("div", { class: "ev notice" }, `Using ${d.label} · `, h("code", {}, d.model), d.attempt > 1 ? ` (attempt ${d.attempt})` : ""));
        break;
      case "thinking":
        add(h("div", { class: "ev thinking" }, d.text));
        break;
      case "text":
        add(h("div", { class: "ev text" }, d.text));
        break;
      case "tool_call": {
        const status = h("span", {}, badge("running"));
        const details = h("div");
        const row = h(
          "div",
          { class: "ev tool" },
          h("div", { class: "row" }, h("span", { class: "tool-name" }, d.name), status),
          h("details", {}, h("summary", {}, "input"), h("pre", {}, pretty(d.input))),
          details,
        );
        toolRows.push({ row, status, details, runId });
        add(row);
        break;
      }
      case "tool_result": {
        const t = toolRows.shift();
        if (!t) break;
        t.row.classList.add(d.status);
        t.status.replaceChildren(badge(d.status), " ", badge(d.risk), " ", h("span", { class: "meta" }, d.summary));
        if (d.logId) {
          const out = h("pre", {}, "loading…");
          const det = h("details", {}, h("summary", {}, "output"), out);
          det.addEventListener("toggle", async () => {
            if (!det.open || out.dataset.loaded) return;
            out.dataset.loaded = "1";
            try {
              const r = await api("GET", `/api/runs/${t.runId}`);
              const a = r.actions.find((x) => x.id === d.logId);
              out.textContent = a ? pretty(a.output_json ?? a.error ?? "(none)") : "(not found)";
            } catch (err) {
              out.textContent = err.message;
            }
          });
          t.details.append(det);
        }
        break;
      }
      case "turn":
        add(
          h(
            "div",
            { class: "meta", style: "padding-left:4px" },
            `step ${d.step} · in ${fmtNum(d.usage.inputTokens)} · cached ${fmtNum(d.usage.cacheReadTokens)} · out ${fmtNum(d.usage.outputTokens)} · ${d.servedBy}`,
          ),
        );
        break;
      case "approval_request": {
        const buttons = h(
          "div",
          { class: "row", style: "margin-top:10px" },
          h("button", { class: "ok", onclick: () => decide(true) }, "Approve"),
          h("button", { class: "danger", onclick: () => decide(false) }, "Deny"),
        );
        const card = h(
          "div",
          { class: "ev approval", "data-approval": d.id },
          h("div", { class: "row" }, h("b", {}, "Approval needed: "), h("span", { class: "tool-name" }, d.tool), badge(d.risk), d.reason === "rule" ? badge("agent rule: always ask", "reversible") : null),
          h("pre", {}, pretty(d.input)),
          buttons,
        );
        async function decide(approved) {
          for (const b of buttons.querySelectorAll("button")) b.disabled = true;
          try {
            await api("POST", `/api/runs/${runId}/approvals/${d.id}`, { approved });
          } catch (err) {
            toast(err.message, true);
          }
        }
        add(card);
        if (document.hidden) document.title = "⚠️ Approval needed · deskpilot";
        break;
      }
      case "approval_resolved": {
        const card = container.querySelector(`[data-approval="${CSS.escape(d.id)}"]`);
        if (card) {
          card.classList.add("resolved");
          card.querySelector(".row:last-child")?.replaceChildren(badge(d.approved ? "approved" : "denied", d.approved ? "ok" : "blocked"), h("span", { class: "meta" }, ` by ${d.by}`));
        }
        document.title = "deskpilot";
        break;
      }
      case "fallback":
        add(h("div", { class: "ev notice" }, `${d.from} couldn't start (${d.reason}). Falling back to ${d.to}…`));
        follow(d.nextRunId);
        break;
      case "stopping":
        add(h("div", { class: "ev notice" }, "Stopping after the current step…"));
        break;
      case "end": {
        const s = d.summary;
        const bad = s.status !== "completed";
        add(
          h(
            "div",
            { class: `ev end${bad ? " bad" : ""}` },
            h("div", { class: "row" }, badge(s.status), h("span", { class: "meta" }, `${s.steps} steps${s.usage ? ` · in ${fmtNum(s.usage.inputTokens)} + cached ${fmtNum(s.usage.cacheReadTokens)} · out ${fmtNum(s.usage.outputTokens)}` : ""}`)),
            s.error ? h("div", { class: "meta", style: "margin-top:4px" }, s.error) : null,
          ),
        );
        break;
      }
      case "closed":
        onEnd?.(runId);
        break;
    }
  }

  function follow(runId) {
    source?.close();
    currentRunId = runId;
    const es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events?t=${encodeURIComponent(TOKEN)}`);
    source = es;
    es.addEventListener("message", (m) => {
      const { type, data } = JSON.parse(m.data);
      render(type, data, runId);
      if (type === "closed" || (type === "fallback" && data.nextRunId !== runId)) {
        if (type === "closed") es.close();
      }
    });
    es.addEventListener("idle", () => {
      // Finished run: history fully replayed.
      es.close();
      onEnd?.(runId);
    });
  }

  return {
    follow,
    close: () => source?.close(),
    runId: () => currentRunId,
    count: () => count,
  };
}

// ── Run a task ───────────────────────────────────────────────────────────────
async function viewRun() {
  const [agents, prov] = await Promise.all([api("GET", "/api/agents"), api("GET", "/api/providers"), meta()]);
  if (!agents.length) {
    mount(h("h1", {}, "Run a task"), h("div", { class: "card empty" }, "No agents yet. ", h("a", { href: "#/agents/new" }, "Create one")));
    return;
  }
  const last = localStorage.getItem("deskpilot-last-agent");
  const agentSel = h("select", {}, agents.map((a) => h("option", { value: a.name, selected: a.name === last }, a.name)));
  const agentInfo = h("div", { class: "hint" });
  const connSel = h("select");
  const modelIn = h("input", { type: "text", placeholder: "model (optional override)", list: "run-models" });
  const modelList = h("datalist", { id: "run-models" });
  const task = h("textarea", { class: "task", placeholder: "What should the agent do?" });
  const startBtn = h("button", { class: "primary" }, "Start");
  const timelineBox = h("div", { class: "timeline" });
  const stopBtn = h("button", { class: "danger", hidden: true }, "Stop");
  let timeline = null;

  function fillConn() {
    const a = agents.find((x) => x.name === agentSel.value);
    const own = a.model.connection ?? (a.model.provider === "anthropic" ? "anthropic" : "openai");
    agentInfo.textContent = `${a.description || ""} · default: ${own} / ${a.model.id} · ${a.tools.join(", ")}`;
    connSel.replaceChildren(
      h("option", { value: "" }, `Agent default (${own} · ${a.model.id})`),
      ...prov.connections
        .filter((c) => c.enabled)
        .map((c) => h("option", { value: c.id, disabled: !c.keySet }, `${c.label}${c.defaultModel ? ` · ${c.defaultModel}` : ""}${c.keySet ? "" : " (no key)"}`)),
    );
    modelList.replaceChildren(...(modelCache[connSel.value || own] ?? []).map((m) => h("option", { value: m })));
  }
  agentSel.addEventListener("change", fillConn);
  connSel.addEventListener("change", fillConn);
  fillConn();

  async function start() {
    if (!task.value.trim()) return toast("Describe the task first", true);
    startBtn.disabled = true;
    try {
      localStorage.setItem("deskpilot-last-agent", agentSel.value);
      const { runId } = await api("POST", "/api/runs", { agent: agentSel.value, task: task.value, connection: connSel.value || undefined, model: modelIn.value || undefined });
      timelineBox.replaceChildren();
      timeline?.close();
      timeline = createTimeline(timelineBox, {
        onEnd: () => {
          startBtn.disabled = false;
          stopBtn.hidden = true;
          refreshFoot();
        },
      });
      timeline.follow(runId);
      stopBtn.hidden = false;
      stopBtn.onclick = async () => {
        stopBtn.disabled = true;
        await api("POST", `/api/runs/${timeline.runId()}/stop`).catch((e) => toast(e.message, true));
      };
      refreshFoot();
    } catch (err) {
      toast(err.message, true);
      startBtn.disabled = false;
    }
  }
  startBtn.addEventListener("click", start);
  task.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start();
  });
  cleanup = () => timeline?.close();

  mount(
    h("h1", {}, "Run a task"),
    h("p", { class: "sub" }, "Pick an agent, optionally choose which AI runs it, and watch every step. Irreversible actions wait for your approval here."),
    h(
      "div",
      { class: "card" },
      h("div", { class: "grid" }, h("div", {}, h("label", {}, "Agent"), agentSel), h("div", {}, h("label", {}, "AI provider"), connSel), h("div", {}, h("label", {}, "Model"), modelIn, modelList)),
      agentInfo,
      h("label", {}, "Task"),
      task,
      h("div", { class: "row", style: "margin-top:12px" }, startBtn, stopBtn, h("span", { class: "hint" }, "⌘↩ to start")),
    ),
    timelineBox,
  );
  if (META.activeRunId) {
    timeline = createTimeline(timelineBox, { onEnd: () => ((startBtn.disabled = false), (stopBtn.hidden = true)) });
    timeline.follow(META.activeRunId);
    startBtn.disabled = true;
    stopBtn.hidden = false;
    stopBtn.onclick = () => api("POST", `/api/runs/${timeline.runId()}/stop`);
  }
}

// ── Agents ───────────────────────────────────────────────────────────────────
async function viewAgents() {
  const agents = await api("GET", "/api/agents");
  mount(
    h("div", { class: "row" }, h("div", {}, h("h1", {}, "Agents"), h("p", { class: "sub" }, "Each agent is a JSON file in agents/: its role, tools, model and limits.")), h("div", { class: "spacer" }), h("a", { href: "#/agents/new" }, h("button", { class: "primary" }, "New agent"))),
    agents.length
      ? h(
          "div",
          { class: "grid" },
          agents.map((a) =>
            h(
              "div",
              { class: "card" },
              h("div", { class: "row" }, h("b", {}, a.name), h("div", { class: "spacer" }), badge(a.model.connection ?? a.model.provider, "")),
              h("p", { class: "sub", style: "margin:6px 0" }, a.description || "—"),
              h("div", { class: "stats" }, h("span", {}, "model ", h("b", {}, a.model.id)), h("span", {}, "tools ", h("b", {}, a.tools.join(", "))), h("span", {}, "steps ", h("b", {}, a.budget.maxSteps))),
              a.approval.alwaysAsk.length ? h("div", { class: "hint" }, `Always asks before: ${a.approval.alwaysAsk.join(", ")}`) : null,
              h(
                "div",
                { class: "row", style: "margin-top:12px" },
                h("a", { href: `#/agents/edit/${a.name}` }, h("button", {}, "Edit")),
                h("a", { href: `#/agents/copy/${a.name}` }, h("button", {}, "Duplicate")),
                h("div", { class: "spacer" }),
                h(
                  "button",
                  {
                    class: "danger",
                    onclick: async (e) => {
                      const b = e.currentTarget;
                      if (b.dataset.armed !== "1") {
                        b.dataset.armed = "1";
                        b.textContent = "Click again to delete";
                        return;
                      }
                      try {
                        await api("DELETE", `/api/agents/${a.name}`);
                        toast(`Deleted ${a.name} (moved to data/agents-trash)`);
                        viewAgents();
                      } catch (err) {
                        toast(err.message, true);
                      }
                    },
                  },
                  "Delete",
                ),
              ),
            ),
          ),
        )
      : h("div", { class: "card empty" }, "No agents yet."),
  );
}

async function viewAgentEditor(name, copy = false) {
  const [agents, prov] = await Promise.all([api("GET", "/api/agents"), api("GET", "/api/providers"), meta()]);
  const existing = name ? agents.find((a) => a.name === name) : null;
  if (name && !existing) throw new Error(`no agent named ${name}`);
  const base = existing ?? {
    name: "",
    description: "",
    system: "",
    tools: ["shell.run", "applescript.run", "ui.*"],
    model: { provider: "openai-compatible", connection: "openai", id: "", maxTokensPerTurn: 16000 },
    budget: { maxSteps: 20, maxOutputTokens: 60000, maxSeconds: 300 },
    approval: { alwaysAsk: [] },
  };
  const isNew = !existing || copy;
  const f = {
    name: h("input", { type: "text", value: copy ? `${base.name}-copy` : base.name, disabled: !isNew, placeholder: "lowercase-with-dashes" }),
    description: h("input", { type: "text", value: base.description, placeholder: "What is this agent for?" }),
    system: h("textarea", { placeholder: "Role and instructions, e.g. You are a cybersecurity analyst. Audit this Mac's open ports and running services; never change settings." }, base.system),
    conn: h("select", {}, prov.connections.map((c) => h("option", { value: c.id, selected: c.id === (base.model.connection ?? (base.model.provider === "anthropic" ? "anthropic" : "openai")) }, `${c.label}${c.keySet ? "" : " (no key)"}`))),
    model: h("input", { type: "text", value: base.model.id, list: "editor-models", placeholder: "model id" }),
    effort: h("select", {}, ["", "low", "medium", "high", "xhigh", "max"].map((e) => h("option", { value: e, selected: (base.model.effort ?? "") === e }, e || "provider default"))),
    maxTokens: h("input", { type: "number", value: base.model.maxTokensPerTurn ?? 16000, min: 1024, max: 128000 }),
    maxSteps: h("input", { type: "number", value: base.budget.maxSteps, min: 1, max: 500 }),
    maxOut: h("input", { type: "number", value: base.budget.maxOutputTokens, min: 1000 }),
    maxSec: h("input", { type: "number", value: base.budget.maxSeconds, min: 10 }),
  };
  const modelList = h("datalist", { id: "editor-models" });
  const loadBtn = h("button", {}, "Load models");
  function fillModels() {
    modelList.replaceChildren(...(modelCache[f.conn.value] ?? []).map((m) => h("option", { value: m })));
  }
  f.conn.addEventListener("change", () => {
    const c = prov.connections.find((x) => x.id === f.conn.value);
    if (c?.defaultModel && !f.model.value) f.model.value = c.defaultModel;
    fillModels();
  });
  loadBtn.addEventListener("click", async () => {
    loadBtn.disabled = true;
    const r = await api("POST", `/api/providers/${f.conn.value}/test`).catch((e) => ({ ok: false, error: e.message }));
    loadBtn.disabled = false;
    if (!r.ok) return toast(r.error, true);
    modelCache[f.conn.value] = r.models;
    fillModels();
    toast(`${r.models.length} models available`);
  });
  fillModels();

  // Tool picker: per-family "all" glob or individual tools, plus an "always ask" column.
  const tools = META.tools.filter((t) => t.agentVisible);
  const families = [...new Set(tools.map((t) => familyOf(t.name)))];
  const has = (list, n) => list.includes(n) || list.includes("*") || list.includes(`${familyOf(n)}.*`);
  const toolBoxes = new Map();
  const askBoxes = new Map();
  const famBoxes = new Map();
  const toolsUi = families.map((fam) => {
    const members = tools.filter((t) => familyOf(t.name) === fam);
    const glob = members.length > 1 || members[0].name.includes(".") ? `${fam}.*` : fam;
    const famBox = h("input", { type: "checkbox", checked: base.tools.includes(glob) || base.tools.includes("*") });
    famBoxes.set(glob, famBox);
    const rows = members.map((t) => {
      const cb = h("input", { type: "checkbox", checked: has(base.tools, t.name) });
      const ask = h("input", { type: "checkbox", checked: has(base.approval.alwaysAsk, t.name), title: "Always ask before running" });
      toolBoxes.set(t.name, cb);
      askBoxes.set(t.name, ask);
      return h("div", { class: "check", title: t.description }, cb, h("span", { class: "tool-name" }, t.name), badge(t.baseRisk), h("span", { class: "spacer" }), ask, h("span", { class: "hint", style: "margin:0" }, "ask"));
    });
    famBox.addEventListener("change", () => members.forEach((t) => (toolBoxes.get(t.name).checked = famBox.checked)));
    const head = members.length > 1 ? h("div", { class: "family-head" }, famBox, `${fam} (all)`) : null;
    return h("div", { class: "family" }, head, h("div", { class: "tools-grid" }, rows));
  });

  function collect() {
    const toolList = [];
    for (const [glob, box] of famBoxes) {
      const fam = glob.replace(/\.\*$/, "");
      const members = tools.filter((t) => familyOf(t.name) === fam);
      if (box.checked && members.every((t) => toolBoxes.get(t.name).checked)) toolList.push(glob);
      else members.forEach((t) => toolBoxes.get(t.name).checked && toolList.push(t.name));
    }
    const conn = prov.connections.find((c) => c.id === f.conn.value);
    const model = {
      provider: conn.kind,
      connection: conn.id,
      id: f.model.value.trim() || conn.defaultModel,
      ...(conn.kind === "openai-compatible" && conn.baseUrl && { baseUrl: conn.baseUrl }),
      ...(conn.keyEnv && conn.kind !== "anthropic" && { apiKeyEnv: conn.keyEnv }),
      ...(f.effort.value && { effort: f.effort.value }),
      maxTokensPerTurn: Number(f.maxTokens.value),
    };
    return {
      name: f.name.value.trim(),
      description: f.description.value.trim(),
      system: f.system.value.trim(),
      tools: toolList,
      model,
      budget: { maxSteps: Number(f.maxSteps.value), maxOutputTokens: Number(f.maxOut.value), maxSeconds: Number(f.maxSec.value) },
      approval: { alwaysAsk: [...askBoxes].filter(([, b]) => b.checked).map(([n]) => n) },
    };
  }

  const jsonPre = h("pre", { hidden: true });
  const saveBtn = h("button", { class: "primary" }, isNew ? "Create agent" : "Save");
  saveBtn.addEventListener("click", async () => {
    const def = collect();
    if (!def.model.id) return toast("Pick a model (or set a default model for this provider in Providers)", true);
    if (isNew && agents.some((a) => a.name === def.name)) return toast(`An agent named ${def.name} already exists`, true);
    saveBtn.disabled = true;
    try {
      await api("PUT", `/api/agents/${encodeURIComponent(def.name)}`, def);
      toast(`Saved ${def.name}`);
      location.hash = "#/agents";
    } catch (err) {
      toast(err.message, true);
      saveBtn.disabled = false;
    }
  });

  mount(
    h("h1", {}, isNew ? (copy ? `Duplicate ${name}` : "New agent") : `Edit ${name}`),
    h("p", { class: "sub" }, "The safety rules (approval for irreversible actions, untrusted-content handling) are added to every agent automatically."),
    h(
      "div",
      { class: "card" },
      h("div", { class: "grid" }, h("div", {}, h("label", {}, "Name"), f.name), h("div", {}, h("label", {}, "Description"), f.description)),
      h("label", {}, "Role / instructions"),
      f.system,
      h("h2", {}, "Model"),
      h("div", { class: "grid" }, h("div", {}, h("label", {}, "Provider"), f.conn), h("div", {}, h("label", {}, "Model"), h("div", { class: "row", style: "flex-wrap:nowrap" }, f.model, loadBtn), modelList), h("div", {}, h("label", {}, "Effort"), f.effort)),
      h("h2", {}, "Limits"),
      h("div", { class: "grid" }, h("div", {}, h("label", {}, "Max steps"), f.maxSteps), h("div", {}, h("label", {}, "Max output tokens (whole run)"), f.maxOut), h("div", {}, h("label", {}, "Max seconds"), f.maxSec), h("div", {}, h("label", {}, "Max tokens per turn"), f.maxTokens)),
      h("h2", {}, "Tools"),
      h("div", { class: "hint" }, "Tick what this agent may use. “ask” = needs your approval every time, even if the action is reversible. Irreversible actions always ask."),
      toolsUi,
      h(
        "div",
        { class: "row", style: "margin-top:18px" },
        saveBtn,
        h("a", { href: "#/agents" }, h("button", {}, "Cancel")),
        h("div", { class: "spacer" }),
        h("button", { onclick: () => ((jsonPre.hidden = !jsonPre.hidden), (jsonPre.textContent = JSON.stringify(collect(), null, 2))) }, "Show JSON"),
      ),
      jsonPre,
    ),
  );
}

// ── Runs ─────────────────────────────────────────────────────────────────────
async function viewRuns() {
  const runs = await api("GET", "/api/runs");
  mount(
    h("h1", {}, "Runs"),
    h("p", { class: "sub" }, "Every agent run, newest first. Open one to see its full workflow."),
    runs.length
      ? h(
          "table",
          {},
          h("tr", {}, ["Started", "Agent", "Model", "Status", "Steps", "Tokens (in / out)", "Task"].map((c) => h("th", {}, c))),
          runs.map((r) =>
            h(
              "tr",
              { class: "click", onclick: () => (location.hash = `#/runs/${r.id}`) },
              h("td", {}, fmtTime(r.started_at)),
              h("td", {}, r.agent),
              h("td", {}, h("code", {}, r.model)),
              h("td", {}, badge(r.status)),
              h("td", {}, r.steps),
              h("td", {}, `${fmtNum(r.input_tokens + r.cache_read_tokens)} / ${fmtNum(r.output_tokens)}`),
              h("td", { class: "trunc", title: r.task }, r.task),
            ),
          ),
        )
      : h("div", { class: "card empty" }, "No runs yet."),
  );
}

async function viewRunDetail(id) {
  const d = await api("GET", `/api/runs/${id}`);
  const r = d.run;
  const timelineBox = h("div", { class: "timeline" });
  const stopBtn = h("button", { class: "danger", hidden: !d.active }, "Stop");
  stopBtn.addEventListener("click", () => api("POST", `/api/runs/${id}/stop`).catch((e) => toast(e.message, true)));
  mount(
    h("div", { class: "row" }, h("a", { href: "#/runs" }, "← Runs"), h("div", { class: "spacer" }), stopBtn),
    h("h1", { style: "margin-top:10px" }, r.task),
    h(
      "div",
      { class: "card" },
      h(
        "div",
        { class: "stats" },
        h("span", {}, badge(r.status)),
        h("span", {}, "agent ", h("b", {}, r.agent)),
        h("span", {}, "model ", h("b", {}, `${r.provider} / ${r.model}`)),
        h("span", {}, "steps ", h("b", {}, r.steps)),
        h("span", {}, "tokens ", h("b", {}, `${fmtNum(r.input_tokens)} in + ${fmtNum(r.cache_read_tokens)} cached · ${fmtNum(r.output_tokens)} out`)),
        h("span", {}, "duration ", h("b", {}, duration(r.started_at, r.ended_at))),
        h("span", {}, "tool calls ", h("b", {}, d.actions.length)),
      ),
      r.error ? h("div", { class: "hint" }, r.error) : null,
      h("div", { class: "hint" }, `id ${r.id} · started ${fmtTime(r.started_at)}`),
    ),
    h("h2", {}, "Workflow"),
    timelineBox,
  );
  const tl = createTimeline(timelineBox, {
    onEnd: () => {
      stopBtn.hidden = true;
      // Runs recorded before event timelines existed: rebuild from the action log.
      if (tl.count() === 0) renderFromActions(timelineBox, d);
    },
  });
  tl.follow(id);
  cleanup = () => tl.close();
}

function renderFromActions(box, d) {
  box.append(h("div", { class: "ev notice" }, "This run predates saved timelines; showing its logged tool calls."));
  for (const a of d.actions) {
    box.append(
      h(
        "div",
        { class: `ev tool ${a.status}` },
        h("div", { class: "row" }, h("span", { class: "tool-name" }, a.tool), badge(a.status), badge(a.risk), h("span", { class: "meta" }, `${a.duration_ms}ms`)),
        h("details", {}, h("summary", {}, "input"), h("pre", {}, pretty(a.input_json))),
        a.output_json || a.error ? h("details", {}, h("summary", {}, "output"), h("pre", {}, pretty(a.output_json ?? a.error))) : null,
      ),
    );
  }
  if (d.run.final_text) box.append(h("div", { class: "ev text" }, d.run.final_text));
}

// ── Providers ────────────────────────────────────────────────────────────────
async function viewProviders() {
  const prov = await api("GET", "/api/providers");
  const order = [...prov.settings.providerOrder];

  const cards = prov.connections.map((c) => {
    const keyIn = h("input", { type: "password", placeholder: c.keySet ? "•••••••• (set; paste to replace)" : `paste ${c.keyEnv}`, autocomplete: "off" });
    const baseIn = h("input", { type: "text", value: c.baseUrl ?? "", disabled: c.kind === "anthropic" });
    const modelIn = h("input", { type: "text", value: c.defaultModel, list: `models-${c.id}`, placeholder: "default model id" });
    const list = h("datalist", { id: `models-${c.id}` }, (modelCache[c.id] ?? []).map((m) => h("option", { value: m })));
    const enabled = h("input", { type: "checkbox", checked: c.enabled });
    const result = h("div", { class: "hint" });
    const keyPill = c.keyEnv ? badge(c.keySet ? "key set" : "no key", c.keySet ? "set" : "missing") : badge("no key needed", "set");

    async function save() {
      try {
        if (keyIn.value.trim()) {
          await api("PUT", `/api/providers/${c.id}/key`, { key: keyIn.value.trim() });
          keyIn.value = "";
        }
        await api("PUT", `/api/providers/${c.id}`, { defaultModel: modelIn.value, enabled: enabled.checked, ...(c.kind !== "anthropic" && { baseUrl: baseIn.value }) });
        toast(`Saved ${c.label}`);
        viewProviders();
      } catch (err) {
        toast(err.message, true);
      }
    }
    async function test() {
      result.textContent = "Testing…";
      const r = await api("POST", `/api/providers/${c.id}/test`).catch((e) => ({ ok: false, error: e.message }));
      if (r.ok) {
        modelCache[c.id] = r.models;
        list.replaceChildren(...r.models.map((m) => h("option", { value: m })));
        result.replaceChildren(badge("ok"), ` ${r.models.length} models available. Pick one in “Default model”.`);
      } else result.replaceChildren(badge("error"), ` ${r.error}`);
    }
    return h(
      "div",
      { class: "card" },
      h("div", { class: "row" }, h("b", {}, c.label), keyPill, h("div", { class: "spacer" }), h("label", { class: "check", style: "margin:0;text-transform:none" }, enabled, "enabled")),
      c.keyEnv ? h("div", {}, h("label", {}, `API key (${c.keyEnv})`), keyIn, h("div", { class: "hint" }, "Saved to .env on this machine and never shown again.")) : null,
      c.kind !== "anthropic" ? h("div", {}, h("label", {}, "Base URL"), baseIn) : null,
      h("label", {}, "Default model"),
      modelIn,
      list,
      h("div", { class: "row", style: "margin-top:12px" }, h("button", { class: "primary", onclick: save }, "Save"), h("button", { onclick: test }, "Test & list models")),
      result,
    );
  });

  const orderBox = h("div");
  const fallback = h("input", { type: "checkbox", checked: prov.settings.fallbackOnStartFailure });
  function drawOrder() {
    orderBox.replaceChildren(
      ...order.map((id, i) => {
        const c = prov.connections.find((x) => x.id === id);
        const ready = c && c.enabled && c.keySet && c.defaultModel;
        return h(
          "div",
          { class: "order-item" },
          h("span", { class: "pos" }, `${i + 1}.`),
          h("span", {}, c?.label ?? id),
          ready ? badge("ready", "ok") : badge(!c?.keySet ? "no key" : !c?.defaultModel ? "no model" : "disabled", "missing"),
          h("div", { class: "spacer" }),
          h("button", { disabled: i === 0, onclick: () => (([order[i - 1], order[i]] = [order[i], order[i - 1]]), drawOrder()) }, "↑"),
          h("button", { disabled: i === order.length - 1, onclick: () => (([order[i + 1], order[i]] = [order[i], order[i + 1]]), drawOrder()) }, "↓"),
        );
      }),
    );
  }
  drawOrder();
  const saveOrder = h("button", { class: "primary" }, "Save routing");
  saveOrder.addEventListener("click", async () => {
    try {
      await api("PUT", "/api/providers/settings", { providerOrder: order, fallbackOnStartFailure: fallback.checked });
      toast("Routing saved");
    } catch (err) {
      toast(err.message, true);
    }
  });

  mount(
    h("h1", {}, "Providers"),
    h("p", { class: "sub" }, "Connect the AIs agents can use. Keys stay in .env on this machine."),
    h(
      "div",
      { class: "card" },
      h("h2", { style: "margin-top:0" }, "Routing"),
      h("div", { class: "hint" }, "When a run uses the agent's default provider and that provider can't start (no key, no credits, unreachable), deskpilot retries on the next ready provider in this order. Choosing a provider explicitly on the Run screen disables fallback for that run."),
      orderBox,
      h("label", { class: "check", style: "text-transform:none;margin-top:12px" }, fallback, "Fall back to the next provider if a run can't start"),
      h("div", { class: "row", style: "margin-top:10px" }, saveOrder),
    ),
    h("div", { class: "grid" }, cards),
  );
}

// ── Activity log ─────────────────────────────────────────────────────────────
async function viewActivity() {
  await meta();
  const tool = h("select", {}, h("option", { value: "" }, "all tools"), META.tools.map((t) => h("option", { value: t.name }, t.name)));
  const risk = h("select", {}, ["", "read_only", "reversible", "irreversible"].map((r) => h("option", { value: r }, r || "any risk")));
  const status = h("select", {}, ["", "ok", "error", "blocked"].map((s) => h("option", { value: s }, s || "any status")));
  const table = h("div");
  async function load() {
    const q = new URLSearchParams({ limit: "300", ...(tool.value && { tool: tool.value }), ...(risk.value && { risk: risk.value }), ...(status.value && { status: status.value }) });
    const rows = await api("GET", `/api/actions?${q}`);
    table.replaceChildren(
      rows.length
        ? h(
            "table",
            {},
            h("tr", {}, ["#", "Time", "Caller", "Tool", "Risk", "Status", "ms", "Input"].map((c) => h("th", {}, c))),
            rows.map((a) => {
              const tr = h(
                "tr",
                { class: "click" },
                h("td", {}, a.id),
                h("td", {}, fmtTime(a.ts)),
                h("td", {}, a.session_id.startsWith("run-") ? h("a", { href: `#/runs/${a.session_id}`, onclick: (e) => e.stopPropagation() }, a.caller) : a.caller),
                h("td", {}, h("span", { class: "tool-name" }, a.tool)),
                h("td", {}, badge(a.risk)),
                h("td", {}, badge(a.status)),
                h("td", {}, a.duration_ms),
                h("td", { class: "trunc" }, a.input_json),
              );
              let open = null;
              tr.addEventListener("click", () => {
                if (open) return open.remove(), (open = null);
                open = h("tr", {}, h("td", { colspan: 8 }, h("b", {}, "Input"), h("pre", {}, pretty(a.input_json)), a.error ? [h("b", {}, "Error"), h("pre", {}, a.error)] : null, a.output_json ? [h("b", {}, "Output"), h("pre", {}, pretty(a.output_json))] : null));
                tr.after(open);
              });
              return tr;
            }),
          )
        : h("div", { class: "card empty" }, "No matching actions."),
    );
  }
  for (const s of [tool, risk, status]) s.addEventListener("change", load);
  mount(h("h1", {}, "Activity log"), h("p", { class: "sub" }, "Every tool call: by hand, from scripts, or from agents. Click a row for details."), h("div", { class: "row", style: "margin-bottom:12px" }, tool, risk, status), table);
  await load();
}

// ── Boot ─────────────────────────────────────────────────────────────────────
if (!TOKEN) {
  mount(h("div", { class: "card" }, h("h1", {}, "Not connected"), h("p", {}, "Open the control panel with `npm run gui` so it gets this session's access token.")));
} else {
  refreshFoot();
  route();
}
