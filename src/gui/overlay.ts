// Launches the desktop avatar overlay (native/overlay, macOS) and relays its events.
// Windows/Linux get their own small host for the same page later (Phase 3).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { z } from "zod";
import { DATA_DIR, ensureDir, ROOT } from "../core/paths.ts";

export const OVERLAY_PATH = join(ROOT, "native/overlay/.build/release/overlay");
const POSITION_FILE = join(DATA_DIR, "overlay.json");
const Position = z.object({ x: z.number(), y: z.number() });

export interface Overlay {
  stop(): void;
}

/**
 * Start the overlay for a running control panel. `panelUrl` is the tokened URL (…/?t=…); the token
 * goes to the helper over stdin, never on its command line.
 */
export function startOverlay(panelUrl: string, onOpenRun: (runId: string) => void): Overlay | { error: string } {
  if (process.platform !== "darwin") return { error: "the desktop overlay is macOS-only for now" };
  if (!existsSync(OVERLAY_PATH)) return { error: "overlay helper isn't built. Run: npm run build:native" };

  let pos: { x: number; y: number } | undefined;
  try {
    pos = Position.parse(JSON.parse(readFileSync(POSITION_FILE, "utf8")));
  } catch {
    /* first launch: bottom-right corner */
  }
  const origin = new URL(panelUrl).origin;
  const child: ChildProcess = spawn(OVERLAY_PATH, [], { stdio: ["pipe", "pipe", "inherit"] });
  child.stdin!.write(JSON.stringify({ url: `${panelUrl}#/overlay`, origin, width: 640, height: 400, ...pos }) + "\n");

  createInterface({ input: child.stdout! }).on("line", (line) => {
    let msg: { event?: string; runId?: unknown; x?: unknown; y?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.event === "open" && typeof msg.runId === "string" && /^[\w-]{1,80}$/.test(msg.runId)) onOpenRun(msg.runId);
    if (msg.event === "moved") {
      const p = Position.safeParse(msg);
      if (p.success) {
        ensureDir(DATA_DIR);
        writeFileSync(POSITION_FILE, JSON.stringify(p.data) + "\n");
      }
    }
  });
  return {
    stop: () => {
      child.stdin?.end(); // the helper quits when stdin closes
      setTimeout(() => child.kill(), 1000).unref();
    },
  };
}
