import { z } from "zod";
import { runProcess } from "../core/proc.ts";
import type { Risk } from "../core/risk.ts";
import { defineTool, ToolError } from "../core/tool.ts";

const IRREVERSIBLE =
  /\b(delete|send|erase|remove|empty\s+(the\s+)?trash|do\s+shell\s+script|doShellScript|purchase|buy|submit|shut\s*down|restart|log\s*out|eject)\b/i;
const MUTATING =
  /\b(set|make|create|move|duplicate|open|close|quit|activate|launch|run|save|keystroke|key\s+code|click|select|reveal|write|print|display|perform|push|pull)\b|\.(set|make|open|close|quit|activate|click|keystroke)\(/i;

export function classifyAppleScript(script: string): Risk {
  if (IRREVERSIBLE.test(script)) return "irreversible";
  if (MUTATING.test(script)) return "reversible";
  return "read_only";
}

export const applescriptRun = defineTool({
  name: "applescript.run",
  description:
    "Run an AppleScript or JXA (JavaScript for Automation) script via osascript and return its result. macOS only. Prefer this over UI clicking for scriptable apps (Notes, Finder, Mail, Safari, Music…).",
  input: z.object({
    script: z.string().min(1),
    language: z.enum(["applescript", "jxa"]).default("applescript"),
    timeoutMs: z.number().int().min(100).max(300_000).default(30_000),
  }),
  output: z.object({ result: z.string(), stderr: z.string(), durationMs: z.number() }),
  baseRisk: "read_only",
  classify: (i) => classifyAppleScript(i.script),
  platforms: ["darwin"],
  untrustedOutput: true,
  async run(i) {
    const lang = i.language === "jxa" ? "JavaScript" : "AppleScript";
    const res = await runProcess("/usr/bin/osascript", ["-l", lang, "-"], {
      stdin: i.script,
      timeoutMs: i.timeoutMs,
      maxOutputBytes: 1024 * 1024,
    });
    if (res.timedOut) throw new ToolError("timeout", `osascript timed out after ${i.timeoutMs}ms`);
    if (res.exitCode !== 0) {
      const hint = /-1743/.test(res.stderr)
        ? " (Automation permission missing: see docs/permissions.md §1)"
        : "";
      throw new ToolError("osascript_error", res.stderr.trim() + hint);
    }
    return { result: res.stdout.replace(/\n$/, ""), stderr: res.stderr, durationMs: res.durationMs };
  },
});
