// A task = one top-level run the user started, plus the runs it delegates to and its provider
// fallbacks. Several tasks run at the same time; this carries what they need to share the desktop
// (mode, priority) and lets tools clean up per-task resources (e.g. browser tabs) when it ends.

export const PRIORITIES = ["high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const RUN_MODES = ["optimized", "parallel"] as const;
/**
 * optimized: a task keeps the desktop for a short stretch after each action, so sequences like
 *            click → type → Enter aren't split by another task; priority decides who goes next.
 * parallel:  each desktop action takes its turn on its own, first come first served.
 */
export type RunMode = (typeof RUN_MODES)[number];

export interface TaskInfo {
  /** Stable id: the first run id of the task. */
  id: string;
  mode: RunMode;
  /** Read on every desktop turn, so a change while the task runs takes effect right away. */
  priority(): Priority;
}

const cleanups = new Map<string, Array<() => unknown>>();

/** Run fn when the task ends (once). */
export function onTaskEnd(taskId: string, fn: () => unknown): void {
  let list = cleanups.get(taskId);
  if (!list) cleanups.set(taskId, (list = []));
  list.push(fn);
}

/** Release everything the task held. Errors in one cleanup don't stop the others. */
export async function endTask(taskId: string): Promise<void> {
  const list = cleanups.get(taskId) ?? [];
  cleanups.delete(taskId);
  for (const fn of list) {
    try {
      await fn();
    } catch {
      /* best effort */
    }
  }
}
