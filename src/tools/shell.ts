import { z } from "zod";
import { ensureDir, SCRATCH_DIR } from "../core/paths.ts";
import { runProcess } from "../core/proc.ts";
import type { Risk } from "../core/risk.ts";
import { defineTool } from "../core/tool.ts";

// ── Risk heuristics ──────────────────────────────────────────────────────────
// A heuristic, not a sandbox: it decides when to ask for approval. Unknown commands
// default to "reversible"; anything resembling deletion, overwriting, privilege
// escalation, process killing or network writes is "irreversible".

const IRREVERSIBLE: RegExp[] = [
  /\b(rm|rmdir|unlink|shred|srm|truncate|dd|mkfs\S*|fdisk|kill|killall|pkill|shutdown|reboot|halt|sudo|doas|su|eval|exec)\b/,
  /\bmv\b/, // can overwrite the destination
  /\bdiskutil\s+(erase|partition|apfs\s+delete|zero|secureErase)/,
  /\bgit\s+(push|clean|rebase|filter-branch|filter-repo)\b/,
  /\bgit\s+reset\s+.*--hard/,
  /\bgit\s+(checkout|restore)\s+.*(--\s|\.)/,
  /\bgit\s+(branch|tag)\s+.*-[dD]\b/,
  /\bgit\s+stash\s+(drop|clear)/,
  /\bcurl\b.*(\s-X\s*(POST|PUT|PATCH|DELETE)|\s--request\s+(POST|PUT|PATCH|DELETE)|\s-d\b|\s--data|\s-F\b|\s--form|\s-T\b|\s--upload-file)/i,
  /\bwget\b.*--(post|method|body)/i,
  /\|\s*(sh|bash|zsh|fish|python3?|node|perl|ruby)\b/, // piping into an interpreter
  /\b(ssh|scp|sftp|rsync)\b/,
  /\b(npm|pnpm|yarn)\s+(publish|unpublish|deprecate)\b/,
  /\b(brew|pip3?|npm|gem)\s+(uninstall|remove|rm)\b/,
  /\b(osascript|launchctl|tccutil|csrutil|spctl|security|crontab|systemsetup|networksetup\s+-set|pmset\s+-[^g])\b/,
  /\bdefaults\s+(write|delete)\b/,
  /\bfind\b.*\s-(delete|exec|execdir|ok)\b/,
  /\b(mail|sendmail|mutt)\b/,
  /\b(docker|podman)\s+(rm|rmi|system\s+prune|volume\s+rm)\b/,
  /\bkubectl\s+delete\b/,
  /\bterraform\s+(apply|destroy)\b/,
  // PowerShell (Windows backend, Phase 3)
  /\b(Remove-Item|Stop-Process|Format-Volume|Clear-Content|Restart-Computer|Stop-Computer)\b/i,
  /\bInvoke-(WebRequest|RestMethod)\b.*-Method\s+(Post|Put|Patch|Delete)/i,
];

const READ_ONLY_CMDS = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "echo", "printf", "which", "whereis", "type", "whoami",
  "id", "date", "uname", "hostname", "sw_vers", "env", "printenv", "grep", "egrep", "fgrep", "rg",
  "find", "file", "stat", "du", "df", "ps", "uptime", "sort", "uniq", "cut", "tr", "jq", "diff",
  "cmp", "md5", "shasum", "sha256sum", "tree", "basename", "dirname", "realpath", "readlink",
  "test", "true", "false", "mdfind", "mdls", "lsof", "sysctl", "system_profiler", "plutil",
  "xcode-select", "sleep", "seq", "column", "nl", "cal", "locale", "arch", "sw_vers", "true",
]);

const READ_ONLY_GIT = /^git\s+(status|log|diff|show|blame|rev-parse|ls-files|remote(\s+-v)?|branch(\s+(-a|-v|-vv|--list))*|describe|shortlog|config\s+--get)\b/;

/** Strip `2>&1`, `>/dev/null`, `&>/dev/null` which don't write files. */
function stripHarmlessRedirects(cmd: string): string {
  return cmd.replace(/\d*>&\d+/g, " ").replace(/&?\d*>{1,2}\s*\/dev\/null/g, " ");
}

/**
 * Blank out quoted text so a `>` or `|` inside quotes (e.g. awk 'NR>1') isn't read as shell syntax.
 * Double-quoted text that can expand ($, `) is kept as is, and so is an unterminated quote.
 */
function maskQuotes(cmd: string): string {
  return cmd.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\$`]|\\.)*"/g, '""');
}

/** Split on unquoted |, ;, & and newlines. null = unbalanced quotes (don't vouch for it). */
function splitSegments(cmd: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"') cur += cmd[++i] ?? "";
    } else if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === "\\") {
      cur += c + (cmd[++i] ?? "");
    } else if ("|;&\n".includes(c)) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (quote) return null;
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** An awk program that only reads: no system(), getline, pipes, or print/printf redirection. */
function isReadOnlyAwk(segment: string): boolean {
  if (/\s-f\b/.test(segment)) return false; // program in a file we haven't seen
  const program = segment.match(/'([^']*)'/)?.[1];
  if (program === undefined) return false;
  return !/system\s*\(|getline|\|/.test(program) && !/\bprintf?\b[^;}]*>/.test(program);
}

export function classifyShell(command: string): Risk {
  const cmd = stripHarmlessRedirects(command);
  if (IRREVERSIBLE.some((re) => re.test(cmd))) return "irreversible";
  const bare = maskQuotes(cmd);
  // Truncating redirect (`>` not `>>`) overwrites a file.
  if (/(^|[^>])>(?!>)/.test(bare)) return "irreversible";
  if (/>>|\btee\b/.test(bare)) return "reversible";
  if (/\$\(|`/.test(bare)) return "reversible"; // command substitution: don't vouch for it

  const segments = splitSegments(cmd);
  if (!segments) return "reversible";
  const allReadOnly = segments.every((seg) => {
    const words = seg.replace(/^(\w+=\S*\s+)+/, "").split(/\s+/);
    const head = words[0] ?? "";
    if (/^(-v|-V|--version|version)$/.test(words[1] ?? "") && words.length === 2) return true;
    if (head === "git") return READ_ONLY_GIT.test(seg);
    if (head === "sed") return !/\s-i\b|\s--in-place/.test(seg);
    if (head === "awk") return isReadOnlyAwk(seg);
    if (head === "sysctl") return !/\s-w\b|=/.test(seg);
    if (head === "defaults") return /^defaults\s+(read|domains|find)\b/.test(seg);
    return READ_ONLY_CMDS.has(head);
  });
  return allReadOnly ? "read_only" : "reversible";
}

// ── Tool ─────────────────────────────────────────────────────────────────────

function shellFor(platform: NodeJS.Platform): { file: string; args: (cmd: string) => string[] } {
  if (platform === "win32") {
    return { file: "powershell.exe", args: (c) => ["-NoProfile", "-NonInteractive", "-Command", c] };
  }
  return { file: "/bin/bash", args: (c) => ["-c", c] };
}

export const shellRun = defineTool({
  name: "shell.run",
  description:
    "Run a shell command (bash on macOS/Linux, PowerShell on Windows). Default working directory is the project scratch folder. Output is capped and the process is killed on timeout.",
  input: z.object({
    command: z.string().min(1),
    cwd: z.string().optional().describe("Working directory (default: project scratch/)"),
    timeoutMs: z.number().int().min(100).max(600_000).default(30_000),
    maxOutputBytes: z.number().int().min(256).max(4 * 1024 * 1024).default(64 * 1024),
  }),
  output: z.object({
    exitCode: z.number().nullable(),
    signal: z.string().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    truncated: z.boolean(),
    timedOut: z.boolean(),
    durationMs: z.number(),
    shell: z.string(),
    cwd: z.string(),
  }),
  baseRisk: "read_only",
  classify: (i) => classifyShell(i.command),
  untrustedOutput: true,
  async run(i) {
    const sh = shellFor(process.platform);
    const cwd = i.cwd ?? ensureDir(SCRATCH_DIR);
    const res = await runProcess(sh.file, sh.args(i.command), {
      cwd,
      timeoutMs: i.timeoutMs,
      maxOutputBytes: i.maxOutputBytes,
    });
    return { ...res, shell: sh.file, cwd };
  },
});
