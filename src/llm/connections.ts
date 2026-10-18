// Named provider connections (Claude, OpenAI, Grok, …), user settings, and write-only key storage.
// Settings live in data/settings.json (gitignored); keys live only in .env / process.env.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { DATA_DIR, ensureDir, ROOT } from "../core/paths.ts";
import type { ModelSpec } from "./index.ts";

export interface Connection {
  id: string;
  label: string;
  kind: ModelSpec["provider"];
  baseUrl?: string | undefined;
  /** Env var holding the key; undefined = no key needed (local servers). */
  keyEnv?: string | undefined;
  defaultModel: string;
  enabled: boolean;
}

const BUILTIN: Connection[] = [
  { id: "anthropic", label: "Claude (Anthropic)", kind: "anthropic", keyEnv: "ANTHROPIC_API_KEY", defaultModel: "claude-opus-5-5", enabled: true },
  { id: "openai", label: "OpenAI", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", defaultModel: "gpt-5.5", enabled: true },
  { id: "xai", label: "Grok (xAI)", kind: "openai-compatible", baseUrl: "https://api.x.ai/v1", keyEnv: "XAI_API_KEY", defaultModel: "", enabled: true },
  { id: "gemini", label: "Gemini (Google)", kind: "openai-compatible", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyEnv: "GEMINI_API_KEY", defaultModel: "", enabled: true },
  { id: "ollama", label: "Ollama (local)", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", defaultModel: "", enabled: true },
];

export const Settings = z
  .object({
    /** Connection ids in the order to try when a run can't start on the first one. */
    providerOrder: z.array(z.string()).default(["anthropic", "openai", "xai", "gemini", "ollama"]),
    /** If a run fails before its first step (auth, billing, unreachable), retry on the next ready connection. */
    fallbackOnStartFailure: z.boolean().default(true),
    connections: z
      .record(z.string(), z.object({ baseUrl: z.string().url().optional(), defaultModel: z.string().optional(), enabled: z.boolean().optional() }))
      .default({}),
  })
  .prefault({});
export type Settings = z.infer<typeof Settings>;

const SETTINGS_FILE = join(DATA_DIR, "settings.json");
const ENV_FILE = join(ROOT, ".env");

export function loadSettings(): Settings {
  if (!existsSync(SETTINGS_FILE)) return Settings.parse({});
  return Settings.parse(JSON.parse(readFileSync(SETTINGS_FILE, "utf8")));
}

export function saveSettings(s: Settings): Settings {
  const parsed = Settings.parse(s);
  ensureDir(DATA_DIR);
  writeFileSync(SETTINGS_FILE, JSON.stringify(parsed, null, 2) + "\n");
  return parsed;
}

export function listConnections(settings = loadSettings()): Connection[] {
  return BUILTIN.map((c) => ({ ...c, ...settings.connections[c.id] }));
}

export function getConnection(id: string, settings = loadSettings()): Connection | undefined {
  return listConnections(settings).find((c) => c.id === id);
}

export function keyIsSet(c: Connection): boolean {
  return !c.keyEnv || !!process.env[c.keyEnv];
}

/** Ready = enabled, has a key if it needs one, and has a model to use. */
export function isReady(c: Connection): boolean {
  return c.enabled && keyIsSet(c) && !!c.defaultModel;
}

export function toModelSpec(c: Connection, modelId?: string): ModelSpec {
  return { provider: c.kind, id: modelId || c.defaultModel, baseUrl: c.baseUrl, apiKeyEnv: c.keyEnv };
}

/** Write (or replace) one provider key in .env. Only known key names are accepted; values are never read back out. */
export function storeKey(c: Connection, value: string): void {
  if (!c.keyEnv) throw new Error(`${c.label} doesn't use a key`);
  const key = c.keyEnv;
  if (!/^[\x21-\x7e]{8,512}$/.test(value)) throw new Error("key must be 8-512 printable characters, no spaces or newlines");
  const existing = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  const next = re.test(existing) ? existing.replace(re, line) : existing.replace(/\n?$/, existing ? "\n" : "") + line + "\n";
  writeFileSync(ENV_FILE, next, { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
  process.env[key] = value;
}

/** List model ids the connection offers (a free call on every supported provider). */
export async function testConnection(c: Connection): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  try {
    if (c.keyEnv && !process.env[c.keyEnv]) return { ok: false, error: `${c.keyEnv} is not set` };
    if (c.kind === "anthropic") {
      const client = new Anthropic({ apiKey: process.env[c.keyEnv!], ...(c.baseUrl && { baseURL: c.baseUrl }) });
      const models: string[] = [];
      for await (const m of client.models.list({ limit: 100 })) models.push(m.id);
      return { ok: true, models };
    }
    const res = await fetch(`${c.baseUrl!.replace(/\/$/, "")}/models`, {
      headers: c.keyEnv ? { authorization: `Bearer ${process.env[c.keyEnv]}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { data?: Array<{ id: string }>; error?: { message?: string } };
    if (!res.ok) return { ok: false, error: `${res.status}: ${body.error?.message ?? res.statusText}` };
    return { ok: true, models: (body.data ?? []).map((m) => m.id).sort() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
