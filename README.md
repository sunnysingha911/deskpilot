# deskpilot

AI agents that operate your computer through text first: shell, AppleScript, the accessibility
tree, and the browser DOM. Raw mouse and keyboard input is a last resort. Every action is logged,
risk-classified, and gated: anything irreversible (delete, send, submit, purchase) waits for your
approval.

> Status: early. macOS backend working; Windows and Linux backends planned. Agents run on Anthropic
> (Claude), any OpenAI-compatible API (OpenAI, Grok, Gemini), or local models via Ollama.

## How it fits together

```
agents/*.json ──► agent loop ──► ModelProvider (anthropic | openai-compatible)
                      │
                      ▼
                  Executor: validate input → classify risk → approval gate → run → SQLite log
                      │
                      ▼
   tools: shell.run · applescript.run · ui.* · input.* · browser.* · screenshot (not given to agents)
                      │
                      ▼
   platform backend: macOS = Swift helper (Accessibility + Quartz) · Windows/Linux: planned
```

- **Tools** are plain typed functions with zod schemas (exported as JSON Schema), testable without any LLM.
- **Agents are data**: name, system prompt, allowed tools (globs), model, step/token/time budgets, approval rules.
- **Untrusted content** (screen, web, file and command output) reaches the model wrapped in
  `<untrusted_data>` tags and is never treated as instructions.

## Setup (macOS)

Requires Node ≥ 24 and Xcode Command Line Tools (for `swift`).

```sh
npm install
npm run build:native          # builds the Swift accessibility helper
cp .env.example .env          # add the API key(s) you use
```

Grant permissions to your terminal app as described in [docs/permissions.md](docs/permissions.md)
(Accessibility, Automation; Screen Recording only for screenshots). The browser tools drive an
installed Chromium-family browser (Brave/Chrome) with an isolated profile in `data/`.

## Control panel

```sh
npm run gui
```

Builds the React UI (`ui/`, Vite) and opens it in a desktop-style window (your installed Brave/Chrome
in app mode), where you can create and edit
agents, connect Claude / OpenAI / Grok / Gemini / Ollama, run tasks and watch each step live, approve
or deny irreversible actions, and browse past runs and the full action log. The server listens on
127.0.0.1 only and every API call needs a per-launch token.

**Desktop avatars.** `npm run gui` also starts a small transparent window on your desktop (bottom-right;
drag to move) where each working agent appears as a character whose expression follows what it
is doing: thinking, working, worried while waiting for your approval, sad if you decline, happy when
done. They're stylized game-style heroes (outfit, back gear, headgear and a glow colour, all set per agent),
they gather out of magic dust when a run needs them, and disintegrate back into it when they're idle.
Click an avatar to open its run. Pick each agent's look under Agents → edit → Avatar (*Preview on
desktop* plays it). Needs `npm run build:native` once; skip with `npm run gui -- --no-overlay`.

UI development with instant reload: `npm run dev:ui` (core API on :4747, Vite on :5173; open the
printed URL). The UI is React + TypeScript + Vite + Tailwind + shadcn-style components, built to
static files in `ui/dist` so it can later be loaded by an Electron or Tauri shell unchanged.

## Usage

```sh
npm run tool -- list                                   # all tools with base risk
npm run tool -- ui.dump_tree '{"app":"Notes","format":"text"}'
npm run agent -- mac-helper "Which app is frontmost?"  # Claude
npm run agent -- mac-helper-openai "Which app is frontmost?"  # OpenAI
npm run agent -- mac-helper-ollama "Which app is frontmost?"  # local, via Ollama
npm run logs -- 20                                     # recent actions
npm test                                               # unit tests (no network, no LLM)
```

Irreversible tool calls prompt `y/N` in an interactive terminal and are denied otherwise.

## A.R.S.E.N.A.L

**A**daptive **R**esponse **S**ystem **E**ngineered for **N**atural **A**ssistance & **L**earning is
deskpilot's own learning layer: small models built into the app (no AI provider) that learn from every
task you run. Pick **A.R.S.E.N.A.L: let it decide** on the Run page and it chooses the agent, the AI
and how it runs, and tells you why ("job-hunter: you sent 3 similar tasks to it yourself…"). Rate runs
👍 / 👎 to teach it. Its page shows what it has learned about your agents and providers, and suggests
improvements (budgets, models) that you approve; each is tried on 5 tasks and undone automatically if
results get worse. It can't change tools, instructions or approval rules. On the desktop it appears as
a glowing orb (choose its colour on its page).

## Talking with agents

On the Run page (and a run's page) there's a chat box under the timeline: message an agent while it
works ("skip the second site") and it reads it after its current step, or reply after it's done
("now make it a table") to continue the same conversation. Agents can also ask you questions, with
choices as buttons; they wait for your answer (that time doesn't count against their budget).

On the desktop, hover an avatar to see its task, step, time and tokens (it looks at your cursor);
click it to reply, answer its question, approve (press and hold) or deny, change priority, stop, or
open the run. While you type in an avatar's reply box, agents' keyboard/mouse actions wait.

## Several tasks at once

Start as many tasks as you like from the Run page (e.g. the coder, the job-hunter and a creative
agent): they all run side by side, listed under **Running now**, where you can watch, re-prioritize
or stop each one. Thinking, shell commands, files and the browser (each task gets its own tab) run in
parallel; only real keyboard/mouse/app actions take turns, since there's one screen. Pick a mode next
to **Start**:

- **Optimized** (default): a task keeps the desktop for a few seconds after an action, so steps like
  click → type → Enter aren't interrupted by another task; **priority** decides who goes first.
- **Parallel**: no holding; each desktop action takes its turn on its own. Fastest for tasks that
  mostly use the shell, browser and thinking.

The CLI takes `--mode` and `--priority` too, and shares the desktop safely with the control panel.

## Token use

Agents keep their context small automatically: tool results are sent compactly, very long results
are shortened (the agent reads the rest with `result.more` only if it needs it), screen trees use
short element refs, and stale page snapshots / screen dumps are dropped from the conversation once a
newer one exists (on Claude via Anthropic's server-side context editing). The timeline shows what
each run saved; `npm run tokens` reports usage per agent (`-- --replay` re-measures logged outputs).

## Attaching files

Drop files on the task box (or click **Attach files**) on the Run page, or pass `--file` on the CLI:

```bash
npm run agent -- coder "What's the invoice total?" --file ~/Downloads/invoice.pdf
```

Any file type works, up to 10 files of 25 MB each per task. Each is copied into `data/uploads/<id>/`
(your original is never touched) and listed on the run's page for download. The agent gets a
`file.read` tool for that run only, which returns text from plain-text files, code, CSV and JSON,
Word/RTF/HTML (via macOS `textutil`), and PDFs (via PDFKit in the Swift helper); other files get a
description. Images (and PDFs, on Claude) are also shown to the model directly when it can see them:
Claude, OpenAI, and Ollama vision models. Agents it hands work to can read the same files. File
contents are treated as data, never as instructions.

## Agents working together

An agent can hand a sub-task to another agent (`agent.delegate`) and gets its final answer back.
Which agents it may call:

- **Its definition:** `"canDelegateTo": ["notes-reader"]` (Agents → edit → *Can hand work to*).
- **You, per run:** write `@agent-name` in the task, or tick agents under the task box in the panel.
- **You, after a run:** *Send to agent…* on a finished run starts another agent with that run's answer.

```sh
npm run agent -- mac-helper-openai "Ask @notes-reader which buttons are in the Notes toolbar."
```

The called agent uses only its own tools and model, and every action still goes through risk checks,
approvals and logging. Approvals show the whole chain (you → mac-helper → notes-reader). Its task is
marked as coming from another agent, and its answer comes back as untrusted data. Delegation goes at
most two levels deep, never loops, and the called agent's tokens and time count against the caller's
budget. Add `agent.delegate` to `approval.alwaysAsk` (*Ask me before each hand-off*) to approve each one.
If anything in a run was declined, every further hand-off in that run asks you first, so a declined
action can't be passed to a different agent.

### Orchestrator and specialists

`orchestrator` has no desktop tools: it posts a plan (shown as a live checklist), hands each part to
the best-suited agent, checks the answers and combines them.

| Agent | Tools | Notes |
|---|---|---|
| `coder` | `shell.run` | reads code, runs tests, writes in the scratch folder |
| `security-auditor` | `shell.run`, `ui.list_apps` | read-only audit; asks before anything that isn't read-only |
| `job-hunter` | `browser.*` | searches jobs in the isolated browser; never applies on its own |
| `notes-reader` | read-only `ui.*` | Notes app layout, never note contents |

```sh
npm run agent -- orchestrator "How many apps are listening on TCP ports, and how many files are in tests/?"
```

## Project docs

- [CLAUDE.md](CLAUDE.md): goals, design principles, phase plan, invariants
- [docs/permissions.md](docs/permissions.md): macOS permissions and where to grant them
