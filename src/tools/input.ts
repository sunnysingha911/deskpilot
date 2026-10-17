// input.*: synthetic keyboard and mouse events. Last resort after ui.* / applescript / browser.
import { z } from "zod";
import { riskFromLabel, type Risk } from "../core/risk.ts";
import { defineTool, ToolError } from "../core/tool.ts";
import { DESKTOP_PLATFORMS, requireBackend } from "../platform/index.ts";

const FrontApp = z
  .string()
  .min(1)
  .describe("Name or bundle id of the app that must be frontmost. The call fails if another app is in front, since input would go there.");

/** Synthetic input goes to whatever is focused, so refuse unless the expected app is in front. */
export async function requireFrontmost(app: string): Promise<void> {
  const front = (await requireBackend().listApps()).find((a) => a.frontmost);
  const want = app.toLowerCase();
  if (!front || (front.name.toLowerCase() !== want && front.bundleId.toLowerCase() !== want)) {
    throw new ToolError(
      "wrong_frontmost_app",
      `expected '${app}' to be frontmost, but '${front?.name ?? "nothing"}' is. Activate it first (e.g. applescript.run: tell application "${app}" to activate).`,
    );
  }
}

/** Keys that commonly submit/send the focused form, or force-empty the trash. */
export function classifyHotkey(keys: string[]): Risk {
  const k = keys.map((s) => s.toLowerCase());
  if (k.includes("return") || k.includes("enter")) return "irreversible";
  const has = (...xs: string[]) => xs.every((x) => k.includes(x) || (x === "cmd" && k.includes("command")));
  if (has("cmd", "shift", "delete") || has("cmd", "shift", "backspace")) return "irreversible";
  return "reversible";
}

export const inputType = defineTool({
  name: "input.type",
  description:
    "Type text into whatever has keyboard focus, as synthetic key events. Newlines press Return (which can submit forms, so they require approval).",
  input: z.object({
    app: FrontApp,
    text: z.string().min(1).max(20_000),
    delayMs: z.number().int().min(0).max(500).default(8),
    sensitive: z.boolean().default(false).describe("Don't store the text in the action log"),
  }),
  output: z.object({ typedChars: z.number() }),
  baseRisk: "reversible",
  classify: (i) => (/[\r\n]/.test(i.text) ? "irreversible" : "reversible"),
  platforms: DESKTOP_PLATFORMS,
  untrustedOutput: false,
  redactInput: (i) => (i.sensitive ? { ...i, text: `[redacted ${i.text.length} chars]` } : i),
  async run(i) {
    await requireFrontmost(i.app);
    return requireBackend().typeText(i.text, i.delayMs);
  },
});

export const inputHotkey = defineTool({
  name: "input.hotkey",
  description: 'Press a key combination, e.g. ["cmd","n"], ["cmd","shift","4"], ["escape"]. Return/Enter requires approval.',
  input: z.object({ app: FrontApp, keys: z.array(z.string().min(1)).min(1).max(6) }),
  output: z.object({ keys: z.array(z.string()) }),
  baseRisk: "reversible",
  classify: (i) => classifyHotkey(i.keys),
  platforms: DESKTOP_PLATFORMS,
  untrustedOutput: false,
  async run(i) {
    await requireFrontmost(i.app);
    return requireBackend().hotkey(i.keys);
  },
});

export const inputClick = defineTool({
  name: "input.click",
  description:
    "Click at screen coordinates (points, origin top-left of main display). Prefer ui.press. The element under the cursor is inspected first; Send/Delete/Buy-style targets require approval.",
  input: z.object({
    app: FrontApp,
    x: z.number(),
    y: z.number(),
    button: z.enum(["left", "right"]).default("left"),
    count: z.number().int().min(1).max(3).default(1),
  }),
  output: z.object({
    x: z.number(),
    y: z.number(),
    target: z.object({ role: z.string().optional(), title: z.string().optional(), app: z.string().optional() }).nullable(),
  }),
  baseRisk: "reversible",
  async classify(i) {
    const { element } = await requireBackend().elementAt(i.x, i.y);
    return element ? riskFromLabel(element.title, element.description, element.identifier) : "reversible";
  },
  platforms: DESKTOP_PLATFORMS,
  untrustedOutput: true,
  async run(i) {
    await requireFrontmost(i.app);
    const b = requireBackend();
    const hit = await b.elementAt(i.x, i.y).catch(() => ({ app: null, element: null }));
    await b.click(i.x, i.y, i.button, i.count);
    return {
      x: i.x,
      y: i.y,
      target: hit.element
        ? {
            ...(hit.element.role && { role: hit.element.role }),
            ...(hit.element.title && { title: hit.element.title }),
            ...(hit.app && { app: hit.app.name }),
          }
        : null,
    };
  },
});
