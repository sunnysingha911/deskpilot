// Phase 0 check: read the frontmost app's name via AppleScript.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const script =
  'tell application "System Events" to get name of first application process whose frontmost is true';

try {
  const { stdout } = await run("osascript", ["-e", script], { timeout: 5_000 });
  console.log(JSON.stringify({ ok: true, frontmostApp: stdout.trim() }));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.log(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
}
