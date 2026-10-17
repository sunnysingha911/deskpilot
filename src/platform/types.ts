// OS-neutral desktop backend. One implementation per OS (macOS now; Windows, Linux in Phase 3).
import { z } from "zod";

export const AppRef = z
  .union([z.string().min(1), z.number().int().positive()])
  .describe('App name ("Notes"), bundle id ("com.apple.Notes"), pid, or "frontmost"');

export const Frame = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

export const AppInfo = z.object({
  name: z.string(),
  bundleId: z.string(),
  pid: z.number(),
  frontmost: z.boolean(),
});
export type AppInfo = z.infer<typeof AppInfo>;

const nodeFields = {
  path: z.string().describe('Child-index path from the app root, e.g. "1.0.3"'),
  role: z.string().optional(),
  subrole: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  identifier: z.string().optional(),
  placeholder: z.string().optional(),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  enabled: z.boolean().optional(),
  focused: z.boolean().optional(),
  frame: Frame.optional(),
  actions: z.array(z.string()).optional(),
  valueSettable: z.boolean().optional(),
  childCount: z.number().optional(),
};

export const UIElement = z.object(nodeFields);
export type UIElement = z.infer<typeof UIElement>;

export interface UINode extends UIElement {
  children?: UINode[];
}
export const UINode: z.ZodType<UINode> = z.object({
  ...nodeFields,
  get children() {
    return z.array(UINode).optional();
  },
});

export const Selector = z
  .object({
    role: z.string().optional().describe('e.g. "AXButton", "AXTextField", "AXTextArea"'),
    subrole: z.string().optional(),
    title: z.string().optional().describe("exact title"),
    titleContains: z.string().optional().describe("case-insensitive substring of title"),
    identifier: z.string().optional(),
    description: z.string().optional().describe("exact description"),
    descriptionContains: z.string().optional(),
    nth: z.number().int().min(0).optional().describe("0-based index among matches (default 0)"),
  })
  .strict();
export type Selector = z.infer<typeof Selector>;

/** Address one element: by path from a tree dump, or by selector (breadth-first). */
/** Prefer selectors for actions: paths shift when the UI changes (e.g. after typing a search). */
export const Target = z
  .object({
    app: AppRef,
    path: z.string().optional(),
    selector: Selector.optional(),
    under: z.string().optional().describe("Only search below this path (selector mode)"),
  })
  .refine((t) => (t.path !== undefined) !== (t.selector !== undefined), {
    message: "provide exactly one of 'path' or 'selector'",
  });
export type Target = z.infer<typeof Target>;

export interface TreeOptions {
  app: string | number;
  path?: string | undefined;
  maxDepth?: number | undefined;
  maxNodes?: number | undefined;
  includeMenuBar?: boolean | undefined;
  maxValueLength?: number | undefined;
}

export interface TreeResult {
  app: AppInfo;
  tree: UINode;
  nodeCount: number;
  truncated: boolean;
}

export interface DesktopBackend {
  readonly id: string;
  checkAccess(): Promise<{ trusted: boolean }>;
  listApps(): Promise<AppInfo[]>;
  dumpTree(opts: TreeOptions): Promise<TreeResult>;
  find(app: string | number, selector: Selector, opts?: { under?: string | undefined; limit?: number; includeMenuBar?: boolean | undefined }): Promise<{ app: AppInfo; matches: UIElement[] }>;
  inspect(target: Target): Promise<{ app: AppInfo; element: UIElement }>;
  press(target: Target, action?: string): Promise<{ app: AppInfo; element: UIElement; action: string }>;
  setValue(target: Target, value: string): Promise<{ app: AppInfo; element: UIElement; verified: boolean }>;
  elementAt(x: number, y: number): Promise<{ app: AppInfo | null; element: UIElement | null }>;
  typeText(text: string, delayMs?: number): Promise<{ typedChars: number }>;
  hotkey(keys: string[]): Promise<{ keys: string[] }>;
  click(x: number, y: number, button: "left" | "right", count: number): Promise<void>;
  screenshot(outPath: string, region?: z.infer<typeof Frame>): Promise<{ path: string; width: number; height: number; bytes: number }>;
}

/** Render a UI tree as compact indented text (cheaper for LLMs than JSON). */
export function renderTree(node: UINode, depth = 0, lines: string[] = []): string {
  const bits = [`[${node.path || "root"}]`, node.role ?? "?"];
  if (node.subrole) bits.push(`(${node.subrole})`);
  if (node.title) bits.push(JSON.stringify(node.title));
  if (node.description && node.description !== node.title) bits.push(`desc=${JSON.stringify(node.description)}`);
  if (node.identifier) bits.push(`id=${node.identifier}`);
  if (node.placeholder) bits.push(`placeholder=${JSON.stringify(node.placeholder)}`);
  if (node.value !== undefined && node.value !== "") bits.push(`value=${JSON.stringify(node.value)}`);
  if (node.valueSettable) bits.push("settable");
  if (node.enabled === false) bits.push("disabled");
  if (node.focused) bits.push("focused");
  if (node.childCount !== undefined && !node.children?.length) bits.push(`+${node.childCount} children`);
  lines.push("  ".repeat(depth) + bits.join(" "));
  for (const c of node.children ?? []) renderTree(c, depth + 1, lines);
  return lines.join("\n");
}
