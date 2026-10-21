"""shell.run: run a shell command on the runner's computer.

Risk is a heuristic, not a sandbox: it decides when to ask for approval. Unknown commands default to
"reversible"; anything resembling deletion, overwriting, privilege escalation, process killing or
network writes is "irreversible". (The runner's local policy additionally refuses some outright.)
"""

import re
import sys

from pydantic import Field

from deskpilot.config import REPO_ROOT
from deskpilot.core.proc import run_process
from deskpilot.core.risk import Risk
from deskpilot.core.tool import ToolContext, ToolDef, ToolModel

IRREVERSIBLE = [
    re.compile(p, flags)
    for p, flags in [
        (
            r"\b(rm|rmdir|unlink|shred|srm|truncate|dd|mkfs\S*|fdisk|kill|killall|pkill|shutdown|reboot|halt|sudo|doas|su|eval|exec)\b",
            0,
        ),
        (r"\bmv\b", 0),  # can overwrite the destination
        (r"\bdiskutil\s+(erase|partition|apfs\s+delete|zero|secureErase)", 0),
        (r"\bgit\s+(push|clean|rebase|filter-branch|filter-repo)\b", 0),
        (r"\bgit\s+reset\s+.*--hard", 0),
        (r"\bgit\s+(checkout|restore)\s+.*(--\s|\.)", 0),
        (r"\bgit\s+(branch|tag)\s+.*-[dD]\b", 0),
        (r"\bgit\s+stash\s+(drop|clear)", 0),
        (
            r"\bcurl\b.*(\s-X\s*(POST|PUT|PATCH|DELETE)|\s--request\s+(POST|PUT|PATCH|DELETE)|\s-d\b|\s--data|\s-F\b|\s--form|\s-T\b|\s--upload-file)",
            re.IGNORECASE,
        ),
        (r"\bwget\b.*--(post|method|body)", re.IGNORECASE),
        (r"\|\s*(sh|bash|zsh|fish|python3?|node|perl|ruby)\b", 0),  # piping into an interpreter
        (r"\b(ssh|scp|sftp|rsync)\b", 0),
        (r"\b(npm|pnpm|yarn)\s+(publish|unpublish|deprecate)\b", 0),
        (r"\b(brew|pip3?|npm|gem)\s+(uninstall|remove|rm)\b", 0),
        (
            r"\b(osascript|launchctl|tccutil|csrutil|spctl|security|crontab|systemsetup|networksetup\s+-set|pmset\s+-[^g])\b",
            0,
        ),
        (r"\bdefaults\s+(write|delete)\b", 0),
        (r"\bfind\b.*\s-(delete|exec|execdir|ok)\b", 0),
        (r"\b(mail|sendmail|mutt)\b", 0),
        (r"\b(docker|podman)\s+(rm|rmi|system\s+prune|volume\s+rm)\b", 0),
        (r"\bkubectl\s+delete\b", 0),
        (r"\bterraform\s+(apply|destroy)\b", 0),
        # PowerShell (Windows runner)
        (r"\b(Remove-Item|Stop-Process|Format-Volume|Clear-Content|Restart-Computer|Stop-Computer)\b", re.IGNORECASE),
        (r"\bInvoke-(WebRequest|RestMethod)\b.*-Method\s+(Post|Put|Patch|Delete)", re.IGNORECASE),
    ]
]

READ_ONLY_CMDS = frozenset(
    [
        "ls",
        "cat",
        "head",
        "tail",
        "wc",
        "pwd",
        "echo",
        "printf",
        "which",
        "whereis",
        "type",
        "whoami",
        "id",
        "date",
        "uname",
        "hostname",
        "sw_vers",
        "env",
        "printenv",
        "grep",
        "egrep",
        "fgrep",
        "rg",
        "find",
        "file",
        "stat",
        "du",
        "df",
        "ps",
        "uptime",
        "sort",
        "uniq",
        "cut",
        "tr",
        "jq",
        "diff",
        "cmp",
        "md5",
        "shasum",
        "sha256sum",
        "tree",
        "basename",
        "dirname",
        "realpath",
        "readlink",
        "test",
        "true",
        "false",
        "mdfind",
        "mdls",
        "lsof",
        "sysctl",
        "system_profiler",
        "plutil",
        "xcode-select",
        "sleep",
        "seq",
        "column",
        "nl",
        "cal",
        "locale",
        "arch",
    ]
)
READ_ONLY_GIT = re.compile(
    r"^git\s+(status|log|diff|show|blame|rev-parse|ls-files|remote(\s+-v)?|branch(\s+(-a|-v|-vv|--list))*|describe|shortlog|config\s+--get)\b"
)


def _strip_harmless_redirects(cmd: str) -> str:
    """`2>&1`, `>/dev/null`, `&>/dev/null` don't write files."""
    return re.sub(r"&?\d*>{1,2}\s*/dev/null", " ", re.sub(r"\d*>&\d+", " ", cmd))


def _mask_quotes(cmd: str) -> str:
    """Blank out quoted text so a `>` or `|` inside quotes (awk 'NR>1') isn't read as shell syntax.
    Double-quoted text that can expand ($, `) is kept, and so is an unterminated quote."""
    return re.sub(r'"(?:[^"\\$`]|\\.)*"', '""', re.sub(r"'[^']*'", "''", cmd))


def _split_segments(cmd: str) -> list[str] | None:
    """Split on unquoted |, ;, & and newlines. None = unbalanced quotes (don't vouch for it)."""
    out: list[str] = []
    cur = ""
    quote: str | None = None
    i = 0
    while i < len(cmd):
        c = cmd[i]
        if quote:
            cur += c
            if c == quote:
                quote = None
            elif c == "\\" and quote == '"':
                i += 1
                cur += cmd[i] if i < len(cmd) else ""
        elif c in ("'", '"'):
            quote = c
            cur += c
        elif c == "\\":
            i += 1
            cur += c + (cmd[i] if i < len(cmd) else "")
        elif c in "|;&\n":
            if cur.strip():
                out.append(cur.strip())
            cur = ""
        else:
            cur += c
        i += 1
    if quote:
        return None
    if cur.strip():
        out.append(cur.strip())
    return out


def _read_only_awk(segment: str) -> bool:
    """An awk program that only reads: no system(), getline, pipes, or print/printf redirection."""
    if re.search(r"\s-f\b", segment):
        return False  # program in a file we haven't seen
    m = re.search(r"'([^']*)'", segment)
    if m is None:
        return False
    program = m.group(1)
    return not re.search(r"system\s*\(|getline|\|", program) and not re.search(r"\bprintf?\b[^;}]*>", program)


def classify_shell(command: str) -> Risk:
    cmd = _strip_harmless_redirects(command)
    if any(r.search(cmd) for r in IRREVERSIBLE):
        return Risk.IRREVERSIBLE
    bare = _mask_quotes(cmd)
    if re.search(r"(^|[^>])>(?!>)", bare):  # truncating redirect overwrites a file
        return Risk.IRREVERSIBLE
    if re.search(r">>|\btee\b", bare):
        return Risk.REVERSIBLE
    if re.search(r"\$\(|`", bare):  # command substitution: don't vouch for it
        return Risk.REVERSIBLE

    segments = _split_segments(cmd)
    if segments is None:
        return Risk.REVERSIBLE

    def read_only(seg: str) -> bool:
        words = re.sub(r"^(\w+=\S*\s+)+", "", seg).split()
        head = words[0] if words else ""
        if len(words) == 2 and re.fullmatch(r"-v|-V|--version|version", words[1]):
            return True
        if head == "git":
            return bool(READ_ONLY_GIT.search(seg))
        if head == "sed":
            return not re.search(r"\s-i\b|\s--in-place", seg)
        if head == "awk":
            return _read_only_awk(seg)
        if head == "sysctl":
            return not re.search(r"\s-w\b|=", seg)
        if head == "defaults":
            return bool(re.match(r"defaults\s+(read|domains|find)\b", seg))
        return head in READ_ONLY_CMDS

    return Risk.READ_ONLY if all(read_only(s) for s in segments) else Risk.REVERSIBLE


def _shell_for(platform: str) -> tuple[str, list[str]]:
    if platform == "win32":
        return "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command"]
    return "/bin/bash", ["-c"]


class ShellIn(ToolModel):
    command: str = Field(min_length=1)
    cwd: str | None = Field(default=None, description="Working directory (default: project scratch/)")
    timeout_ms: int = Field(default=30_000, ge=100, le=600_000)
    max_output_bytes: int = Field(default=64 * 1024, ge=256, le=4 * 1024 * 1024)


class ShellOut(ToolModel):
    exit_code: int | None
    signal: str | None
    stdout: str
    stderr: str
    truncated: bool
    timed_out: bool
    duration_ms: int
    shell: str
    cwd: str


async def _classify(i: ShellIn, _ctx: ToolContext) -> Risk:
    return classify_shell(i.command)


async def _run(i: ShellIn, _ctx: ToolContext) -> ShellOut:
    file, prefix = _shell_for(sys.platform)
    cwd = i.cwd or str(REPO_ROOT / "scratch")
    if i.cwd is None:
        (REPO_ROOT / "scratch").mkdir(exist_ok=True)
    r = await run_process(file, [*prefix, i.command], cwd=cwd, timeout_ms=i.timeout_ms, max_output_bytes=i.max_output_bytes)
    return ShellOut(
        exit_code=r.exit_code,
        signal=r.signal,
        stdout=r.stdout,
        stderr=r.stderr,
        truncated=r.truncated,
        timed_out=r.timed_out,
        duration_ms=r.duration_ms,
        shell=file,
        cwd=cwd,
    )


shell_run = ToolDef(
    name="shell.run",
    description=(
        "Run a shell command (bash on macOS/Linux, PowerShell on Windows). Default working directory is the project "
        "scratch folder. Output is capped and the process is killed on timeout."
    ),
    input=ShellIn,
    output=ShellOut,
    base_risk=Risk.READ_ONLY,
    classify=_classify,
    untrusted_output=True,
    run=_run,
)
