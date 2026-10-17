// macOS backend: Accessibility + Quartz via the Swift helper, screenshots via screencapture.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../core/paths.ts";
import { runProcess } from "../core/proc.ts";
import { ToolError } from "../core/tool.ts";
import type { AppInfo, DesktopBackend, Target, TreeResult, UIElement } from "./types.ts";

export const HELPER_PATH = join(ROOT, "native/axhelper/.build/release/axhelper");

export async function callHelper<T>(command: string, request: object = {}, timeoutMs = 20_000): Promise<T> {
  if (!existsSync(HELPER_PATH)) {
    throw new ToolError("helper_missing", `Swift helper not built. Run: npm run build:native`);
  }
  const res = await runProcess(HELPER_PATH, [command], {
    stdin: JSON.stringify(request),
    timeoutMs,
    maxOutputBytes: 8 * 1024 * 1024,
  });
  if (res.timedOut) throw new ToolError("timeout", `axhelper ${command} timed out after ${timeoutMs}ms`);
  let parsed: { ok: boolean; error?: { code: string; message: string } } & Record<string, unknown>;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new ToolError("helper_bad_output", `axhelper ${command}: ${res.stderr || res.stdout || "no output"}`.slice(0, 2000));
  }
  if (!parsed.ok) throw new ToolError(parsed.error?.code ?? "helper_error", parsed.error?.message ?? "unknown error");
  delete (parsed as Partial<typeof parsed>).ok;
  return parsed as T;
}

function targetReq(t: Target) {
  return { app: t.app, path: t.path, selector: t.selector, under: t.under };
}

export const macosBackend: DesktopBackend = {
  id: "macos",

  checkAccess: () => callHelper("check"),

  listApps: async () => (await callHelper<{ apps: AppInfo[] }>("apps")).apps,

  dumpTree: (o) => callHelper<TreeResult>("tree", o, 60_000),

  find: (app, selector, o = {}) => callHelper("find", { app, selector, ...o }),

  inspect: (t) => callHelper("inspect", targetReq(t)),

  press: (t, action) => callHelper("press", { ...targetReq(t), action }),

  setValue: (t, value) => callHelper("set-value", { ...targetReq(t), value }),

  elementAt: (x, y) => callHelper<{ app: AppInfo | null; element: UIElement | null }>("element-at", { x, y }),

  typeText: (text, delayMs) => callHelper("type", { text, delayMs }, 120_000),

  hotkey: (keys) => callHelper("hotkey", { keys }),

  click: async (x, y, button, count) => {
    await callHelper("click", { x, y, button, count });
  },

  async screenshot(outPath, region) {
    const args = ["-x", "-t", "png"];
    if (region) args.push("-R", `${region.x},${region.y},${region.w},${region.h}`);
    args.push(outPath);
    const res = await runProcess("/usr/sbin/screencapture", args, { timeoutMs: 15_000 });
    if (res.exitCode !== 0 || !existsSync(outPath)) {
      const msg = res.stderr.trim() || `screencapture exited ${res.exitCode}`;
      throw new ToolError("screenshot_failed", `${msg} (likely missing Screen Recording permission: docs/permissions.md §3)`);
    }
    const info = await runProcess("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", outPath], { timeoutMs: 10_000 });
    const num = (k: string) => Number(info.stdout.match(new RegExp(`${k}:\\s*(\\d+)`))?.[1] ?? 0);
    return { path: outPath, width: num("pixelWidth"), height: num("pixelHeight"), bytes: statSync(outPath).size };
  },
};
