// deskpilot control panel: a localhost-only HTTP API + static UI.
//
// This server can make agents act on the computer, so every API call needs the per-launch token,
// requests must target 127.0.0.1/localhost on our port (blocks DNS rebinding), cross-origin requests
// are refused, and the page is served under a strict Content-Security-Policy.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";
import { AGENTS_DIR, AgentDefinition, listAgents, loadAgent } from "../agent/definition.ts";
import { AvatarLook, defaultLook } from "../agent/schema.ts";
import { addStream, AttachmentError, createSet, MAX_FILE_BYTES, getAttachment, listSet, removeAttachment, setExists, SET_ID_RE } from "../core/attachments.ts";
import { ActionLogger } from "../core/logger.ts";
import { desktopLock, USER_TASK_ID } from "../core/desktop-lock.ts";
import { PRIORITIES, RUN_MODES, type Priority, type RunMode } from "../core/task.ts";
import { DATA_DIR, ROOT } from "../core/paths.ts";
import { getConnection, isReady, keyIsSet, listConnections, loadSettings, saveSettings, Settings, storeKey, testConnection } from "../llm/connections.ts";
import { Arsenal, ARSENAL_ID } from "../arsenal/brain.ts";
import { ArsenalStore, HOTKEYS } from "../arsenal/store.ts";
import { Speaker } from "../arsenal/speech.ts";
import { Voice, type Chat } from "../arsenal/voice.ts";
import type { OverlayCommand, OverlayVoiceEvents } from "./overlay.ts";
import { availableTools } from "../tools/index.ts";
import { PresenceTracker, type PresenceTiming } from "./presence.ts";
import { defaultConnectionFor, RunManager } from "./runs.ts";

/** The React UI's production build (npm run build:ui). A desktop shell can load the same folder. */
export const UI_DIST = join(ROOT, "ui", "dist");
const MAX_BODY = 1024 * 1024;
/** Approving from a desktop avatar needs a press-and-hold this long, so a stray (or an agent's) click can't. */
export const OVERLAY_HOLD_MS = 800;
/** ...and no agent may have clicked or typed for this long before it. */
export const OVERLAY_QUIET_MS = 1500;
/** The reply box on the desktop gives the desktop back after this long without activity. */
const TYPING_TIMEOUT_MS = 90_000;
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "request body too large");
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
}

const ATTACHMENT_STATUS: Record<AttachmentError["code"], number> = { bad_set: 404, not_found: 404, too_large: 413, too_many: 400, empty: 400 };

/** Run an attachment operation, mapping its errors to HTTP statuses. */
async function attachmentOp<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AttachmentError) throw new HttpError(ATTACHMENT_STATUS[err.code], err.message);
    throw err;
  }
}

const fileView = (f: { name: string; size: number; mime: string }) => ({ name: f.name, size: f.size, mime: f.mime });

function decodeName(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, "bad file name");
  }
}

function connectionView() {
  const settings = loadSettings();
  return {
    settings: { providerOrder: settings.providerOrder, fallbackOnStartFailure: settings.fallbackOnStartFailure },
    connections: listConnections(settings).map((c) => ({
      id: c.id,
      label: c.label,
      kind: c.kind,
      baseUrl: c.baseUrl ?? null,
      keyEnv: c.keyEnv ?? null,
      keySet: keyIsSet(c),
      defaultModel: c.defaultModel,
      enabled: c.enabled,
      contextLength: c.contextLength ?? null,
    })),
  };
}

export interface GuiServer {
  server: Server;
  url: string;
  token: string;
  /** Push-to-talk wiring for the desktop overlay: pass `events` to startOverlay, then `attach` its send. */
  voiceBridge: { events: OverlayVoiceEvents; attach(send: (cmd: OverlayCommand) => void): void };
  close(): Promise<void>;
}

/** An agent's avatar: its own look, else one derived from its name. */
function lookFor(agent: string): AvatarLook {
  try {
    return loadAgent(agent).avatar ?? defaultLook(agent);
  } catch {
    return defaultLook(agent);
  }
}

export async function startGuiServer(
  opts: {
    port?: number;
    logger?: ActionLogger;
    presenceTiming?: PresenceTiming;
    /** Tests: a fake local model and model list for the voice, and a silent speaker. */
    voice?: { chat?: Chat; listModels?: () => Promise<string[]>; prewarm?: boolean };
    speaker?: Speaker;
  } = {},
): Promise<GuiServer> {
  const token = randomBytes(24).toString("hex");
  const tokenBuf = Buffer.from(token);
  const logger = opts.logger ?? new ActionLogger();
  const presence = new PresenceTracker(lookFor, opts.presenceTiming);
  // A.R.S.E.N.A.L: learns from every task (data/arsenal.db); the first start learns from past runs.
  const arsenalStore = new ArsenalStore();
  const ready = (id: string) => {
    const c = getConnection(id);
    return !!c && c.enabled && isReady(c);
  };
  const arsenal = new Arsenal(arsenalStore, {
    logger,
    agents: () => listAgents(),
    canRun: (d) => ready(d.model.connection ?? defaultConnectionFor(d.model.provider)),
    connectionReady: ready,
  });
  try {
    arsenal.bootstrap();
  } catch {
    /* an unreadable history just means it starts fresh */
  }
  const runs = new RunManager(logger, presence, arsenal);

  // Its voice (local Ollama model), speech (macOS `say`, opt-in) and push-to-talk (the overlay helper).
  const voice = new Voice(arsenal, { chat: opts.voice?.chat, listModels: opts.voice?.listModels });
  const speaker = opts.speaker ?? new Speaker();
  speaker.onChange((on) => (on ? presence.homeSay("talking", "speaking", 60_000) : presence.homeDone()));
  /** Load the natural voice in the background when it will be used, so the first answer isn't slow. */
  const warmVoice = () => {
    const st = arsenal.settings();
    if (st.speak !== "off" && st.speakEngine === "kokoro") void speaker.warmUp()?.catch((err) => console.log(`natural voice unavailable, using macOS say: ${err instanceof Error ? err.message : err}`));
  };
  warmVoice();
  // Have the local model read the current facts ahead of time (shortly after start, then whenever a
  // finished task changes them), so a question is answered in seconds instead of re-reading everything.
  const prewarm = () => {
    if (arsenal.settings().voice) void voice.prewarm();
  };
  const prewarmTimers = opts.voice?.prewarm === false ? [] : [setTimeout(prewarm, 5_000), setInterval(prewarm, 30_000)];
  for (const t of prewarmTimers) t.unref();
  const speakOpts = () => {
    const st = arsenal.settings();
    return { engine: st.speakEngine, voice: (st.speakEngine === "kokoro" ? st.kokoroVoice : st.speakVoice) || undefined, rate: st.speakRate || undefined };
  };
  let overlaySend: ((cmd: OverlayCommand) => void) | null = null;
  const sendVoiceConfig = () => {
    const st = arsenal.settings();
    overlaySend?.({ cmd: "voice", listen: st.listen, hotkey: st.hotkey, locale: st.speechLocale });
  };
  const voiceBridge: GuiServer["voiceBridge"] = {
    events: {
      // Push-to-talk pressed: stop speaking first (so the mic never hears it), then let it listen.
      pttDown: () => {
        if (!arsenal.settings().listen) return overlaySend?.({ cmd: "cancel" });
        speaker.setListening(true);
        presence.homeSay("thinking", "listening", 35_000);
        overlaySend?.({ cmd: "listen" });
      },
      listenEnd: () => {
        speaker.setListening(false);
        presence.homeDone();
      },
      voiceError: (message) => console.log(`push-to-talk: ${message}`),
    },
    attach: (send) => {
      overlaySend = send;
      sendVoiceConfig();
    },
  };
  /**
   * Speak if this request asked for it (`speak: true`) and the setting allows: "always", or "spoken"
   * when the user spoke to it (`spoken: true`, push-to-talk).
   */
  const maybeSpeak = (text: string, b: { speak?: unknown; spoken?: unknown }) => {
    const st = arsenal.settings();
    if (b.speak !== true || st.speak === "off" || (st.speak === "spoken" && b.spoken !== true)) return;
    speaker.speak(text, speakOpts());
  };
  /** Run a voice request; it's unavailable (503) when Ollama or the model isn't there. */
  const voiceOp = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const prev = presence.snapshot().avatars.find((a) => a.key === "arsenal")?.status;
    if (prev && prev !== "speaking" && prev !== "listening") presence.homeSay("thinking", "thinking", 95_000);
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new HttpError(/no finished task/.test(msg) ? 404 : /no agent can run/.test(msg) ? 409 : 503, msg);
    } finally {
      if (!speaker.speaking) presence.homeDone();
    }
  };
  const text = (v: unknown, name: string, max = 2000): string => {
    if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${name} is required`);
    if (v.length > max) throw new HttpError(400, `${name} is too long`);
    return v.trim();
  };
  // Its orb lives on the desktop; the status counts open suggestions.
  const openSuggestions = () => arsenalStore.suggestions().filter((s) => s.status === "open").length;
  const showHome = () => {
    const st = arsenal.settings();
    presence.setHome({ enabled: st.desktop, color: st.color, suggestions: openSuggestions });
  };
  showHome();
  let port = 0;

  // While the user types into an avatar's reply box, the desktop belongs to them.
  let typing: { release: () => void; timer: NodeJS.Timeout } | null = null;
  const stopTyping = () => {
    if (!typing) return;
    clearTimeout(typing.timer);
    typing.release();
    typing = null;
  };
  let typingStarting: Promise<void> | null = null;
  const startTyping = async (): Promise<void> => {
    if (typing) {
      typing.timer.refresh();
      return;
    }
    if (typingStarting) return typingStarting;
    typingStarting = holdForTyping().finally(() => (typingStarting = null));
    return typingStarting;
  };
  const holdForTyping = async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let granted!: () => void;
    const got = new Promise<void>((r) => (granted = r));
    void desktopLock().run({ id: USER_TASK_ID, mode: "parallel", priority: () => "high" }, () => (granted(), held));
    await got;
    typing = { release, timer: setTimeout(stopTyping, TYPING_TIMEOUT_MS) };
  };

  const authorized = (req: IncomingMessage, url: URL): boolean => {
    const given = (req.headers["x-deskpilot-token"] as string | undefined) ?? url.searchParams.get("t") ?? "";
    const buf = Buffer.from(given);
    return buf.length === tokenBuf.length && timingSafeEqual(buf, tokenBuf);
  };

  type Handler = (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray, url: URL) => Promise<unknown> | unknown;
  const routes: Array<[string, RegExp, Handler]> = [
    ["GET", /^\/api\/meta$/, () => ({
      os: process.platform,
      activeRunId: runs.activeRunId(),
      activeRuns: runs.activeRuns(),
      tools: availableTools().map((t) => ({ name: t.name, description: t.description, baseRisk: t.baseRisk, agentVisible: t.agentVisible !== false })),
    })],

    // Agents
    ["GET", /^\/api\/agents$/, () => listAgents()],
    ["PUT", /^\/api\/agents\/([a-z0-9-]+)$/, async (req, _res, m) => {
      const body = await readJson(req);
      const parsed = AgentDefinition.safeParse(body);
      if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
      if (parsed.data.name !== m[1]) throw new HttpError(400, "name in body must match the URL");
      if (parsed.data.name === ARSENAL_ID) throw new HttpError(400, `'${ARSENAL_ID}' is reserved for A.R.S.E.N.A.L`);
      mkdirSync(AGENTS_DIR, { recursive: true });
      writeFileSync(join(AGENTS_DIR, `${m[1]}.json`), JSON.stringify(parsed.data, null, 2) + "\n");
      return parsed.data;
    }],
    ["DELETE", /^\/api\/agents\/([a-z0-9-]+)$/, (_req, _res, m) => {
      const file = join(AGENTS_DIR, `${m[1]}.json`);
      if (!existsSync(file)) throw new HttpError(404, "no such agent");
      // Recoverable: moved to data/agents-trash, not deleted.
      const trash = join(DATA_DIR, "agents-trash");
      mkdirSync(trash, { recursive: true });
      const dest = join(trash, `${m[1]}-${Date.now()}.json`);
      renameSync(file, dest);
      return { trashedTo: dest };
    }],

    // Providers
    ["GET", /^\/api\/providers$/, () => connectionView()],
    ["PUT", /^\/api\/providers\/settings$/, async (req) => {
      const body = await readJson(req);
      const cur = loadSettings();
      const next = Settings.safeParse({ ...cur, ...body, connections: cur.connections });
      if (!next.success) throw new HttpError(400, next.error.message);
      saveSettings(next.data);
      return connectionView();
    }],
    ["PUT", /^\/api\/providers\/([a-z0-9-]+)$/, async (req, _res, m) => {
      if (!getConnection(m[1]!)) throw new HttpError(404, "no such provider");
      const body = await readJson(req);
      const cur = loadSettings();
      const patch: Record<string, unknown> = {};
      if (typeof body.defaultModel === "string") patch.defaultModel = body.defaultModel.trim();
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (typeof body.baseUrl === "string" && body.baseUrl.trim()) patch.baseUrl = body.baseUrl.trim();
      if (typeof body.contextLength === "number") patch.contextLength = Math.round(body.contextLength);
      const next = Settings.safeParse({ ...cur, connections: { ...cur.connections, [m[1]!]: { ...cur.connections[m[1]!], ...patch } } });
      if (!next.success) throw new HttpError(400, next.error.issues.map((i) => i.message).join("; "));
      saveSettings(next.data);
      return connectionView();
    }],
    ["PUT", /^\/api\/providers\/([a-z0-9-]+)\/key$/, async (req, _res, m) => {
      const c = getConnection(m[1]!);
      if (!c) throw new HttpError(404, "no such provider");
      const body = await readJson(req);
      if (typeof body.key !== "string") throw new HttpError(400, "key must be a string");
      try {
        storeKey(c, body.key.trim());
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
      return { keySet: true }; // never echo the key
    }],
    ["POST", /^\/api\/providers\/([a-z0-9-]+)\/test$/, async (_req, _res, m) => {
      const c = getConnection(m[1]!);
      if (!c) throw new HttpError(404, "no such provider");
      return testConnection(c);
    }],

    // Runs
    ["GET", /^\/api\/runs$/, () => logger.listRuns(200)],
    ["POST", /^\/api\/runs$/, async (req) => {
      const b = await readJson(req);
      if (typeof b.agent !== "string" || !NAME_RE.test(b.agent)) throw new HttpError(400, "agent is required");
      if (typeof b.task !== "string" || !b.task.trim()) throw new HttpError(400, "task is required");
      try {
        const started = runs.start({
          agent: b.agent,
          task: b.task.trim(),
          connection: typeof b.connection === "string" && b.connection ? b.connection : undefined,
          model: typeof b.model === "string" && b.model.trim() ? b.model.trim() : undefined,
          with: Array.isArray(b.with) ? b.with.filter((n: unknown): n is string => typeof n === "string" && NAME_RE.test(n)) : undefined,
          fromRun: typeof b.fromRun === "string" && /^[\w-]+$/.test(b.fromRun) ? b.fromRun : undefined,
          attachments: typeof b.attachments === "string" && SET_ID_RE.test(b.attachments) ? b.attachments : undefined,
          mode: RUN_MODES.includes(b.mode) ? (b.mode as RunMode) : undefined,
          priority: PRIORITIES.includes(b.priority) ? (b.priority as Priority) : undefined,
        });
        // A task given by voice gets a spoken "on it" (our own words, not the model's).
        const who = started.decision?.agent ?? b.agent;
        if (b.spoken === true) maybeSpeak(`On it. Sending it to ${String(who).replace(/-/g, " ")}.`, { speak: true, spoken: true });
        return started;
      } catch (err) {
        const status = (err as { status?: number }).status ?? 400;
        throw new HttpError(status, err instanceof Error ? err.message : String(err));
      }
    }],
    ["GET", /^\/api\/runs\/([\w-]+)$/, (_req, _res, m) => {
      const run = logger.getRun(m[1]!);
      if (!run) throw new HttpError(404, "no such run");
      const { transcript_json: _t, ...rest } = run;
      const set = typeof run.attachments === "string" && setExists(run.attachments) ? run.attachments : null;
      const exp = arsenalStore.experience(m[1]!);
      return {
        run: rest,
        attachments: set ? listSet(set).files.map(fileView) : [],
        children: logger.childRuns(m[1]!),
        active: runs.isActive(m[1]!),
        pendingApprovals: runs.pendingApprovals(m[1]!),
        pendingQuestions: runs.pendingQuestions(m[1]!),
        rating: exp?.rating ?? null,
        actions: logger.queryActions({ sessionId: m[1]!, limit: 1000 }).reverse(),
      };
    }],
    // Download an attached file. Always as a download (never rendered here: it's untrusted content).
    ["GET", /^\/api\/runs\/([\w-]+)\/attachments\/([^/]+)$/, (_req, res, m) => {
      const run = logger.getRun(m[1]!);
      if (!run || typeof run.attachments !== "string") throw new HttpError(404, "no such attachment");
      return attachmentOp(() => {
        const f = getAttachment(run.attachments as string, decodeName(m[2]!));
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          "content-type": "application/octet-stream",
          "content-length": String(f.size),
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        });
        createReadStream(f.path).pipe(res);
        return undefined;
      });
    }],
    ["POST", /^\/api\/runs\/([\w-]+)\/priority$/, async (req, _res, m) => {
      const b = await readJson(req);
      if (!PRIORITIES.includes(b.priority)) throw new HttpError(400, `priority must be one of ${PRIORITIES.join(", ")}`);
      if (!runs.setPriority(m[1]!, b.priority)) throw new HttpError(404, "no such running task");
      return { ok: true, priority: b.priority };
    }],
    ["POST", /^\/api\/runs\/([\w-]+)\/stop$/, (_req, _res, m) => ({ stopped: runs.stop(m[1]!) })],
    ["POST", /^\/api\/runs\/([\w-]+)\/approvals\/([\w-]+)$/, async (req, _res, m) => {
      const b = await readJson(req);
      if (typeof b.approved !== "boolean") throw new HttpError(400, "approved must be true or false");
      // The desktop overlay is clickable by anything that moves the mouse, agents included: an approval
      // from there needs a held press and a desktop no agent is driving right now.
      if (b.via === "overlay" && b.approved) {
        if (typeof b.heldMs !== "number" || b.heldMs < OVERLAY_HOLD_MS) throw new HttpError(400, "press and hold Approve");
        if (desktopLock().quietFor() < OVERLAY_QUIET_MS) throw new HttpError(409, "an agent is using the keyboard or mouse right now; try again in a moment");
      }
      const by = b.via === "overlay" ? "user:overlay" : "user:gui";
      if (!runs.decide(m[1]!, m[2]!, b.approved, by)) throw new HttpError(404, "no such pending approval");
      return { ok: true };
    }],
    ["POST", /^\/api\/runs\/([\w-]+)\/questions\/([\w-]+)$/, async (req, _res, m) => {
      const b = await readJson(req);
      if (typeof b.answer !== "string" || !b.answer.trim()) throw new HttpError(400, "answer is required");
      if (!runs.answer(m[1]!, m[2]!, b.answer, b.via === "overlay" ? "user:overlay" : "user:gui")) throw new HttpError(404, "no such open question");
      return { ok: true };
    }],
    // A message for a running agent (delivered after its current step), or a follow-up to a finished run.
    ["POST", /^\/api\/runs\/([\w-]+)\/messages$/, async (req, _res, m) => {
      const b = await readJson(req);
      if (typeof b.text !== "string" || !b.text.trim()) throw new HttpError(400, "text is required");
      try {
        return runs.sendMessage(m[1]!, b.text);
      } catch (err) {
        throw new HttpError((err as { status?: number }).status ?? 400, err instanceof Error ? err.message : String(err));
      }
    }],
    // The reply box on a desktop avatar takes keyboard focus: hold the desktop so no agent types meanwhile.
    ["POST", /^\/api\/overlay\/typing$/, async (req) => {
      const b = await readJson(req);
      if (b.on === true) {
        await startTyping();
        return { holding: true };
      }
      stopTyping();
      return { holding: false };
    }],
    ["GET", /^\/api\/runs\/([\w-]+)\/events$/, (req, res, m, url) => {
      const runId = m[1]!;
      res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive", ...SECURITY_HEADERS });
      const write = (id: number, type: string, data: unknown) => res.write(`id: ${id}\nevent: message\ndata: ${JSON.stringify({ type, data })}\n\n`);
      let last = Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0) || 0;
      // Subscribe first, then replay history, so nothing falls between the two.
      const queue: Array<{ id: number; type: string; data: unknown }> = [];
      let replaying = true;
      const unsubscribe = runs.subscribe(runId, (e) => {
        if (replaying) queue.push(e);
        else if (e.id > last) (write(e.id, e.type, e.data), (last = e.id));
      });
      for (const e of logger.runEvents(runId, last)) {
        write(e.id, e.type, JSON.parse(e.data_json));
        last = e.id;
      }
      replaying = false;
      for (const e of queue) if (e.id > last) (write(e.id, e.type, e.data), (last = e.id));
      if (!runs.isActive(runId)) res.write(`event: idle\ndata: {}\n\n`);
      const ping = setInterval(() => res.write(`: ping\n\n`), 15_000);
      req.on("close", () => {
        clearInterval(ping);
        unsubscribe();
      });
      return undefined;
    }],

    // A.R.S.E.N.A.L
    ["GET", /^\/api\/arsenal$/, () => arsenal.report()],
    ["POST", /^\/api\/arsenal\/decide$/, async (req) => {
      const b = await readJson(req);
      if (typeof b.task !== "string" || !b.task.trim()) throw new HttpError(400, "task is required");
      try {
        return arsenal.decide(b.task);
      } catch (err) {
        throw new HttpError(409, err instanceof Error ? err.message : String(err));
      }
    }],
    ["PUT", /^\/api\/arsenal\/settings$/, async (req) => {
      const b = await readJson(req);
      try {
        const next = arsenal.updateSettings({
          ...(typeof b.color === "string" && { color: b.color }),
          ...(typeof b.memory === "string" && { memory: b.memory }),
          ...(typeof b.exploration === "number" && { exploration: b.exploration }),
          ...(typeof b.desktop === "boolean" && { desktop: b.desktop }),
          ...(typeof b.voice === "boolean" && { voice: b.voice }),
          ...(typeof b.voiceModel === "string" && { voiceModel: b.voiceModel.trim() }),
          ...(typeof b.speak === "string" && { speak: b.speak }),
          ...(typeof b.speakVoice === "string" && { speakVoice: b.speakVoice }),
          ...(typeof b.speakEngine === "string" && { speakEngine: b.speakEngine }),
          ...(typeof b.kokoroVoice === "string" && { kokoroVoice: b.kokoroVoice }),
          ...(typeof b.speakRate === "number" && { speakRate: b.speakRate }),
          ...(typeof b.listen === "boolean" && { listen: b.listen }),
          ...(typeof b.hotkey === "string" && { hotkey: b.hotkey }),
          ...(typeof b.speechLocale === "string" && { speechLocale: b.speechLocale.trim() }),
        });
        showHome();
        sendVoiceConfig();
        if (next.speak === "off") speaker.stop();
        warmVoice();
        void voice.status(true).catch(() => {});
        return next;
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
    }],
    // Its voice: everything it says is written by a local model (the UI labels it so).
    ["GET", /^\/api\/arsenal\/voice$/, async () => {
      const st = arsenal.settings();
      return {
        ...(await voice.status(true)),
        speakAvailable: speaker.available,
        speaking: speaker.speaking,
        engine: st.speakEngine,
        naturalVoiceError: speaker.kokoroError,
        listen: st.listen,
        hotkey: st.hotkey,
        hotkeys: HOTKEYS,
        pushToTalk: overlaySend !== null,
      };
    }],
    ["GET", /^\/api\/arsenal\/voices$/, async () => ({ system: await speaker.voices(), natural: await speaker.kokoroVoices() })],
    // "Test voice" on its page: a fixed line in our own words, spoken whatever the mode.
    ["POST", /^\/api\/arsenal\/speak\/test$/, () => ({ speaking: speaker.speak("Hi, I'm Arsenal. This is how I'll sound when I answer you.", speakOpts()) })],
    ["POST", /^\/api\/arsenal\/forget$/, () => (voice.forget(), { ok: true })],
    ["POST", /^\/api\/arsenal\/ask$/, async (req) => {
      const b = await readJson(req);
      const question = text(b.question, "question");
      const said = await voiceOp(() => voice.ask(question));
      maybeSpeak(said.text, b);
      return said;
    }],
    ["POST", /^\/api\/arsenal\/explain$/, async (req) => {
      const b = await readJson(req);
      const task = text(b.task, "task");
      const said = await voiceOp(() => voice.explain(task));
      maybeSpeak(said.text, b);
      return said;
    }],
    ["POST", /^\/api\/arsenal\/speak\/stop$/, () => (speaker.stop(), { ok: true })],
    ["POST", /^\/api\/runs\/([\w-]+)\/recap$/, async (req, _res, m) => {
      const b = await readJson(req);
      if (runs.isActive(m[1]!)) throw new HttpError(409, "the task is still running");
      const said = await voiceOp(() => voice.recap(m[1]!));
      maybeSpeak(said.text, b);
      return said;
    }],
    ["POST", /^\/api\/arsenal\/suggestions\/(\d+)$/, async (req, _res, m) => {
      const b = await readJson(req);
      try {
        if (b.action === "apply") {
          const r = arsenal.applySuggestion(Number(m[1]), "user:gui");
          presence.refreshHome();
          return r;
        }
        if (b.action === "reject") {
          arsenal.rejectSuggestion(Number(m[1]));
          presence.refreshHome();
          return { ok: true };
        }
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
      throw new HttpError(400, "action must be apply or reject");
    }],
    ["POST", /^\/api\/arsenal\/changes\/(\d+)\/undo$/, (_req, _res, m) => {
      try {
        arsenal.undoChange(Number(m[1]), "user:gui");
        return { ok: true };
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
    }],
    ["POST", /^\/api\/runs\/([\w-]+)\/rating$/, async (req, _res, m) => {
      const b = await readJson(req);
      if (![1, -1, 0].includes(b.rating)) throw new HttpError(400, "rating must be 1, -1 or 0");
      const e = arsenal.rate(m[1]!, b.rating === 0 ? null : b.rating);
      if (!e) throw new HttpError(404, "no finished run with that id");
      return { rating: e.rating, reward: e.reward };
    }],

    // Attachments: upload one file per request (raw body), into a new set or an existing one.
    ["POST", /^\/api\/uploads$/, (req, _res, _m, url) =>
      attachmentOp(async () => {
        const name = url.searchParams.get("name") ?? "";
        if (!name.trim()) throw new HttpError(400, "name is required");
        // Refuse oversized files up front (addStream also stops reading past the limit).
        if (Number(req.headers["content-length"] ?? 0) > MAX_FILE_BYTES) throw new AttachmentError("too_large", `files can be at most ${MAX_FILE_BYTES / 1024 / 1024} MB`);
        const given = url.searchParams.get("set");
        const set = given ?? createSet();
        if (given && !setExists(given)) throw new HttpError(404, "no such attachment set");
        const file = await addStream(set, name, req);
        return { set, file: fileView(file) };
      })],
    ["DELETE", /^\/api\/uploads\/([\w-]+)\/([^/]+)$/, (_req, _res, m) =>
      attachmentOp(() => {
        removeAttachment(m[1]!, decodeName(m[2]!));
        return { ok: true };
      })],

    // Desktop avatars: who is on stage and how they feel (snapshot on connect, then every change).
    ["GET", /^\/api\/presence$/, (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive", ...SECURITY_HEADERS });
      const write = (s: unknown) => res.write(`event: presence\ndata: ${JSON.stringify(s)}\n\n`);
      write(presence.snapshot());
      const unsubscribe = presence.subscribe(write);
      const ping = setInterval(() => res.write(`: ping\n\n`), 15_000);
      req.on("close", () => {
        clearInterval(ping);
        unsubscribe();
      });
      return undefined;
    }],
    ["POST", /^\/api\/presence\/preview$/, async (req) => {
      const b = await readJson(req);
      if (typeof b.agent !== "string" || !NAME_RE.test(b.agent)) throw new HttpError(400, "agent is required");
      const look = AvatarLook.safeParse(b.look ?? lookFor(b.agent));
      if (!look.success) throw new HttpError(400, look.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      presence.preview(b.agent, look.data);
      return { ok: true };
    }],

    // Action log
    ["GET", /^\/api\/actions$/, (_req, _res, _m, url) =>
      logger.queryActions({
        tool: url.searchParams.get("tool") || undefined,
        risk: url.searchParams.get("risk") || undefined,
        status: url.searchParams.get("status") || undefined,
        limit: Number(url.searchParams.get("limit") ?? 200),
      })],
  ];

  const server = createServer(async (req, res) => {
    try {
      // Only accept requests addressed to us on loopback (defeats DNS-rebinding attacks).
      const host = req.headers.host ?? "";
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(421, "bad host");
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) throw new HttpError(403, "cross-origin request refused");

      const url = new URL(req.url ?? "/", `http://${host}`);
      if (url.pathname.startsWith("/api/")) {
        if (!authorized(req, url)) throw new HttpError(401, "missing or wrong token");
        for (const [method, re, handler] of routes) {
          const m = url.pathname.match(re);
          if (m && req.method === method) {
            const out = await handler(req, res, m, url);
            if (out !== undefined && !res.headersSent) send(res, 200, out);
            return;
          }
        }
        throw new HttpError(404, "no such endpoint");
      }

      // Static UI (no secrets in it; the token arrives in the launch URL and stays in the page).
      if (req.method !== "GET") throw new HttpError(405, "method not allowed");
      if (!existsSync(join(UI_DIST, "index.html"))) {
        res.writeHead(503, { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
        res.end("The UI isn't built yet. Run: npm run build:ui");
        return;
      }
      const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      // Only top-level files and assets/<file>: no other paths, no traversal.
      if (!/^(assets\/)?[\w.-]+$/.test(file) || file.includes("..")) throw new HttpError(404, "not found");
      const path = join(UI_DIST, file);
      if (!existsSync(path)) throw new HttpError(404, "not found");
      const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
      res.writeHead(200, { "content-type": `${types[extname(path)] ?? "application/octet-stream"}; charset=utf-8`, ...SECURITY_HEADERS });
      res.end(readFileSync(path));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) send(res, status, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;

  return {
    server,
    url: `http://127.0.0.1:${port}/?t=${token}`,
    token,
    voiceBridge,
    close: async () => {
      for (const t of prewarmTimers) clearTimeout(t);
      speaker.stop();
      overlaySend?.({ cmd: "cancel" });
      stopTyping();
      await runs.shutdown();
      arsenalStore.close();
      await new Promise<void>((resolve) => {
        presence.close();
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
