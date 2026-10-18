// ui.*: read and act on other apps' UI through the OS accessibility layer.
import { z } from "zod";
import { riskFromLabel } from "../core/risk.ts";
import { defineTool } from "../core/tool.ts";
import { DESKTOP_PLATFORMS, requireBackend } from "../platform/index.ts";
import { normalizeRole, pathForRef, refFor, resolveTarget, UI_REF_RE } from "../platform/refs.ts";
import { AppInfo, AppRef, Selector, Target, UIElement, UINode, renderTree } from "../platform/types.ts";

const normSelector = (s: Selector): Selector => ({ ...s, role: normalizeRole(s.role), subrole: normalizeRole(s.subrole) });

/** Refs → paths and "Button" → "AXButton", so the backend gets what it expects. */
function prepTarget<T extends Target>(t: T): T {
  const r = resolveTarget(t);
  return r.selector ? { ...r, selector: normSelector(r.selector) } : r;
}

export const uiListApps = defineTool({
  name: "ui.list_apps",
  description: "List running GUI applications (name, bundle id, pid, frontmost).",
  input: z.object({}),
  output: z.object({ apps: z.array(AppInfo) }),
  baseRisk: "read_only",
  platforms: DESKTOP_PLATFORMS,
  untrustedOutput: false,
  run: async () => ({ apps: await requireBackend().listApps() }),
});

export const uiCheckAccess = defineTool({
  name: "ui.check_access",
  description: "Report whether this process has OS accessibility permission (needed for ui.* and input.*).",
  input: z.object({}),
  output: z.object({ trusted: z.boolean() }),
  baseRisk: "read_only",
  platforms: DESKTOP_PLATFORMS,
  untrustedOutput: false,
  run: () => requireBackend().checkAccess(),
});

export const uiDumpTree = defineTool({
  name: "ui.dump_tree",
  description:
    "Dump an app's accessibility tree (windows, buttons, text fields…) as indented text. Each element starts with a ref like [u12], usable with ui.press / ui.set_value (ref) and as ui.dump_tree's path to dump just that part. Prefer ui.find when you know what you're looking for: it's much smaller. The menu bar is collapsed unless includeMenuBar is true.",
  input: z.object({
    app: AppRef,
    path: z.string().optional().describe("Dump only the subtree at this ref (u12) or path"),
    maxDepth: z.number().int().min(1).max(40).default(12),
    maxNodes: z.number().int().min(1).max(20_000).default(600),
    includeMenuBar: z.boolean().default(false),
    maxValueLength: z.number().int().min(0).max(10_000).default(200).describe("Truncate element values; 0 = omit values"),
    format: z.enum(["text", "json", "both"]).default("both"),
  }),
  output: z.object({
    app: AppInfo,
    nodeCount: z.number(),
    truncated: z.boolean(),
    text: z.string().optional(),
    tree: UINode.optional(),
  }),
  baseRisk: "read_only",
  platforms: DESKTOP_PLATFORMS,
  untrustedOutput: true,
  async run(i) {
    const path = i.path !== undefined && UI_REF_RE.test(i.path) ? pathForRef(i.path, i.app) : i.path;
    const r = await requireBackend().dumpTree({ ...i, path });
    return {
      app: r.app,
      nodeCount: r.nodeCount,
      truncated: r.truncated,
      ...(i.format !== "json" && { text: renderTree(r.tree, 0, [], (p) => refFor(r.app, p)) }),
      ...(i.format !== "text" && { tree: r.tree }),
    };
  },
});

export const uiFind = defineTool({
  name: "ui.find",
  description: "Find UI elements in an app matching a selector (role, title, identifier, description). Returns matching elements, each with a ref (u12) for ui.press / ui.set_value.",
  input: z.object({
    app: AppRef,
    selector: Selector,
    under: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(20),
    includeMenuBar: z.boolean().default(false),
  }),
  output: z.object({ app: AppInfo, matches: z.array(UIElement) }),
  baseRisk: "read_only",
  platforms: DESKTOP_PLATFORMS,
  untrustedOutput: true,
  async run(i) {
    const under = i.under !== undefined && UI_REF_RE.test(i.under) ? pathForRef(i.under, i.app) : i.under;
    const r = await requireBackend().find(i.app, normSelector(i.selector), { under, limit: i.limit, includeMenuBar: i.includeMenuBar });
    return { app: r.app, matches: r.matches.map((m) => ({ ...m, ref: refFor(r.app, m.path) })) };
  },
});

export const uiPress = defineTool({
  name: "ui.press",
  description:
    "Perform an accessibility action (default AXPress = click) on an element, addressed by path or selector. Buttons labelled like Send/Delete/Buy/Submit require user approval.",
  input: Target.safeExtend({ action: z.string().default("AXPress") }),
  output: z.object({ app: AppInfo, element: UIElement, action: z.string() }),
  baseRisk: "reversible",
  async classify(i) {
    const { element } = await requireBackend().inspect(prepTarget(i));
    return riskFromLabel(element.title, element.description, element.identifier);
  },
  platforms: DESKTOP_PLATFORMS,
  untrustedOutput: true,
  run: (i) => requireBackend().press(prepTarget(i), i.action),
});

export const uiSetValue = defineTool({
  name: "ui.set_value",
  description:
    "Set the value of a text field / text area / other settable element (replaces its contents). Faster and more reliable than typing.",
  input: Target.safeExtend({
    value: z.string(),
    sensitive: z.boolean().default(false).describe("Don't store the value in the action log"),
  }),
  output: z.object({ app: AppInfo, element: UIElement, verified: z.boolean() }),
  baseRisk: "reversible",
  platforms: DESKTOP_PLATFORMS,
  untrustedOutput: true,
  redactInput: (i) => (i.sensitive ? { ...i, value: `[redacted ${i.value.length} chars]` } : i),
  run: (i) => requireBackend().setValue(prepTarget(i), i.value),
});
