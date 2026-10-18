// Short refs ("u12") for accessibility elements, used in tree dumps instead of child-index paths
// ("0.0.2.0.47.0.0.2"), which cost many tokens per line. A ref remembers the app and path it came
// from; ui.press / ui.set_value / ui.find resolve it back. Like paths, refs point at a position in
// the tree and go stale when the UI changes. "u" keeps them apart from browser refs ("e12").
import { ToolError } from "../core/tool.ts";
import type { AppInfo, Target } from "./types.ts";

export const UI_REF_RE = /^u\d+$/;
const MAX_REFS = 50_000;

interface RefEntry {
  app: Pick<AppInfo, "name" | "bundleId" | "pid">;
  path: string;
}

const table = new Map<string, RefEntry>();
let counter = 0;

export function refFor(app: RefEntry["app"], path: string): string {
  const ref = `u${++counter}`;
  table.set(ref, { app, path });
  // Oldest first (Map keeps insertion order).
  while (table.size > MAX_REFS) table.delete(table.keys().next().value!);
  return ref;
}

function sameApp(given: string | number, app: RefEntry["app"]): boolean {
  if (typeof given === "number") return given === app.pid;
  const g = given.toLowerCase();
  return g === "frontmost" || g === app.name.toLowerCase() || g === app.bundleId.toLowerCase();
}

/** The path a ref stands for, after checking it belongs to `app`. */
export function pathForRef(ref: string, app: string | number): string {
  const e = table.get(ref);
  if (!e) throw new ToolError("stale_ref", `unknown element ref '${ref}' (refs last only for this session): dump the tree or use ui.find again`);
  if (!sameApp(app, e.app)) throw new ToolError("wrong_app", `ref '${ref}' belongs to ${e.app.name}, not ${String(app)}`);
  return e.path;
}

/** Replace a ref (in `ref` or `under`) by its path, so backends only ever see paths. */
export function resolveTarget<T extends Target>(t: T): T {
  const out = { ...t };
  if (t.ref !== undefined) {
    out.path = pathForRef(t.ref, t.app);
    delete out.ref;
  }
  if (t.under !== undefined && UI_REF_RE.test(t.under)) out.under = pathForRef(t.under, t.app);
  return out;
}

/** Accessibility role names without the "AX" prefix ("Button") are accepted in selectors too. */
export function normalizeRole(role: string | undefined): string | undefined {
  return role && !role.startsWith("AX") ? `AX${role}` : role;
}
