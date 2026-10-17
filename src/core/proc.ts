import { spawn } from "node:child_process";

export interface ProcOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Cap per stream (stdout, stderr), in bytes. Extra output is dropped and `truncated` set. */
  maxOutputBytes?: number;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ProcResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

/** Run a program (no shell interpolation) with a timeout and output cap. Never rejects on non-zero exit. */
export function runProcess(file: string, args: string[], opts: ProcOptions = {}): Promise<ProcResult> {
  const { timeoutMs = 30_000, maxOutputBytes = 64 * 1024 } = opts;
  const started = performance.now();
  const posix = process.platform !== "win32";

  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group on POSIX so a timeout kills the whole tree.
      detached: posix,
      windowsHide: true,
    });

    const bufs = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const sizes = { stdout: 0, stderr: 0 };
    let truncated = false;
    let timedOut = false;

    const collect = (key: "stdout" | "stderr") => (chunk: Buffer) => {
      const room = maxOutputBytes - sizes[key];
      if (room <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length > room) truncated = true;
      const part = chunk.subarray(0, room);
      bufs[key].push(part);
      sizes[key] += part.length;
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));

    const kill = () => {
      try {
        if (posix && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        stdout: Buffer.concat(bufs.stdout).toString("utf8"),
        stderr: Buffer.concat(bufs.stderr).toString("utf8"),
        truncated,
        timedOut,
        durationMs: Math.round(performance.now() - started),
      });
    });

    child.stdin.on("error", () => {
      /* child may exit before reading stdin */
    });
    child.stdin.end(opts.stdin ?? "");
  });
}
