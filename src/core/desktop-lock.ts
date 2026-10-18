// The desktop is one screen, one keyboard and one mouse: actions that drive it (input.*, ui.press,
// ui.set_value, applescript.run) run one at a time, across every task in this process and, through a
// lock file, across processes (the GUI server and `npm run agent` in a terminal). Everything else
// (model calls, shell, files, reading the screen, each task's own browser tab) runs in parallel.
//
// Who goes next:
// - A task in "optimized" mode keeps a short lease after each desktop action (LEASE_MS), so its
//   next action (often in the same model turn: click a field, type, press Enter) isn't split by
//   another task stealing focus. A lease never lasts beyond MAX_STRETCH_MS while others wait, and a
//   higher-priority task may take over a lower-priority lease.
// - Otherwise waiters go by priority (optimized tasks only; "parallel" tasks count as normal), then
//   arrival order.
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, ensureDir } from "./paths.ts";
import type { Priority, TaskInfo } from "./task.ts";

export const LEASE_MS = 5000;
export const MAX_STRETCH_MS = 30_000;
const RANK: Record<Priority, number> = { high: 2, normal: 1, low: 0 };
/** The person at the computer (typing into an avatar's reply box) goes before any agent. */
export const USER_TASK_ID = "user";
const rankOf = (t: TaskInfo | undefined) => (t?.id === USER_TASK_ID ? 3 : t && t.mode === "optimized" ? RANK[t.priority()] : RANK.normal);

/** Cross-process mutex: a file created exclusively, holding our pid. A dead holder's file is taken over. */
export class FileLock {
  constructor(
    private path: string,
    private staleMs = 120_000,
  ) {}

  private alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  tryAcquire(): boolean {
    try {
      writeFileSync(this.path, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let holder: { pid?: number; at?: number } = {};
    try {
      holder = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      /* half-written or unreadable: treat as stale */
    }
    const stale = !holder.pid || !this.alive(holder.pid) || Date.now() - (holder.at ?? 0) > this.staleMs;
    if (stale) {
      try {
        unlinkSync(this.path);
      } catch {
        /* someone else took it over first */
      }
    }
    return false;
  }

  async acquire(): Promise<void> {
    while (!this.tryAcquire()) await new Promise((r) => setTimeout(r, 40));
  }

  release(): void {
    try {
      const holder = JSON.parse(readFileSync(this.path, "utf8")) as { pid?: number };
      if (holder.pid === process.pid) unlinkSync(this.path);
    } catch {
      /* already gone */
    }
  }
}

interface Waiter {
  task: TaskInfo | undefined;
  seq: number;
  grant: () => void;
}

export class DesktopLock {
  private busy = false;
  private waiters: Waiter[] = [];
  private seq = 0;
  private lease: { taskId: string; rank: number; until: number; stretchStart: number } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastEnded = 0;

  private leaseMs: number;
  private maxStretchMs: number;

  constructor(
    private file?: FileLock,
    timing: { leaseMs?: number; maxStretchMs?: number } = {},
  ) {
    this.leaseMs = timing.leaseMs ?? LEASE_MS;
    this.maxStretchMs = timing.maxStretchMs ?? MAX_STRETCH_MS;
  }

  /** Run fn with the desktop to itself. Returns how long it waited for its turn. */
  async run<T>(task: TaskInfo | undefined, fn: () => Promise<T>): Promise<{ value: T; waitedMs: number }> {
    const asked = performance.now();
    await new Promise<void>((grant) => {
      this.waiters.push({ task, seq: ++this.seq, grant });
      this.pump();
    });
    try {
      await this.file?.acquire();
      const waitedMs = Math.round(performance.now() - asked);
      try {
        return { value: await fn(), waitedMs };
      } finally {
        this.file?.release();
      }
    } finally {
      this.busy = false;
      this.lastEnded = Date.now();
      this.afterAction(task);
      this.pump();
    }
  }

  /** Milliseconds since a desktop action in this process last ran (0 while one is running). */
  quietFor(): number {
    return this.busy ? 0 : this.lastEnded ? Date.now() - this.lastEnded : Number.POSITIVE_INFINITY;
  }

  private afterAction(task: TaskInfo | undefined): void {
    const now = Date.now();
    if (!task || task.mode !== "optimized") {
      if (this.lease && this.lease.taskId === task?.id) this.lease = null;
      return;
    }
    const stretchStart = this.lease?.taskId === task.id ? this.lease.stretchStart : now;
    const othersWaiting = this.waiters.some((w) => w.task?.id !== task.id);
    // A long stretch yields to whoever is waiting.
    this.lease = othersWaiting && now - stretchStart >= this.maxStretchMs ? null : { taskId: task.id, rank: rankOf(task), until: now + this.leaseMs, stretchStart };
  }

  private pump(): void {
    if (this.busy || !this.waiters.length) return;
    const now = Date.now();
    if (this.lease && this.lease.until <= now) this.lease = null;
    let pick: Waiter | undefined;
    if (this.lease) {
      // The lease holder continues; a higher-priority task may take over; others wait for it to lapse.
      const lease = this.lease;
      pick = this.waiters.find((w) => w.task?.id === lease.taskId) ?? this.best((w) => rankOf(w.task) > lease.rank);
      if (!pick) {
        if (!this.timer) {
          this.timer = setTimeout(() => {
            this.timer = null;
            this.pump();
          }, lease.until - now + 1);
          this.timer.unref?.();
        }
        return;
      }
    } else {
      pick = this.best(() => true);
    }
    if (!pick) return;
    this.waiters.splice(this.waiters.indexOf(pick), 1);
    if (this.lease && this.lease.taskId !== pick.task?.id) this.lease = null;
    this.busy = true;
    pick.grant();
  }

  private best(ok: (w: Waiter) => boolean): Waiter | undefined {
    let best: Waiter | undefined;
    for (const w of this.waiters) {
      if (!ok(w)) continue;
      if (!best || rankOf(w.task) > rankOf(best.task) || (rankOf(w.task) === rankOf(best.task) && w.seq < best.seq)) best = w;
    }
    return best;
  }
}

let shared: DesktopLock | undefined;

/** The process-wide desktop lock (file lock in data/, or DESKPILOT_DESKTOP_LOCK). */
export function desktopLock(): DesktopLock {
  shared ??= new DesktopLock(new FileLock(process.env.DESKPILOT_DESKTOP_LOCK ?? join(ensureDir(DATA_DIR), "desktop.lock")));
  return shared;
}
