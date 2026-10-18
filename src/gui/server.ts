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
import { PRIORITIES, RUN_MODES, type Priority, type RunMode } from "../core/task.ts";
import { DATA_DIR, ROOT } from "../core/paths.ts";
import { getConnection, keyIsSet, listConnections, loadSettings, saveSettings, Settings, storeKey, testConnection } from "../llm/connections.ts";
import { availableTools } from "../tools/index.ts";
import { PresenceTracker, type PresenceTiming } from "./presence.ts";
import { RunManager } from "./runs.ts";

/** The React UI's production build (npm run build:ui). A desktop shell can load the same folder. */
export const UI_DIST = join(ROOT, "ui", "dist");
const MAX_BODY = 1024 * 1024;
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

export async function startGuiServer(opts: { port?: number; logger?: ActionLogger; presenceTiming?: PresenceTiming } = {}): Promise<GuiServer> {
  const token = randomBytes(24).toString("hex");
  const tokenBuf = Buffer.from(token);
  const logger = opts.logger ?? new ActionLogger();
  const presence = new PresenceTracker(lookFor, opts.presenceTiming);
  const runs = new RunManager(logger, presence);
  let port = 0;

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
        return runs.start({
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
      return {
        run: rest,
        attachments: set ? listSet(set).files.map(fileView) : [],
        children: logger.childRuns(m[1]!),
        active: runs.isActive(m[1]!),
        pendingApprovals: runs.pendingApprovals(m[1]!),
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
      if (!runs.decide(m[1]!, m[2]!, b.approved)) throw new HttpError(404, "no such pending approval");
      return { ok: true };
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
    close: async () => {
      await runs.shutdown();
      await new Promise<void>((resolve) => {
        presence.close();
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
