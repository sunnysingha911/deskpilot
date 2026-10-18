# deskpilot

AI agents that operate your computer through text first: shell, AppleScript, the accessibility
tree, and the browser DOM. Raw mouse and keyboard input is a last resort. Every action is logged,
risk-classified, and gated: anything irreversible (delete, send, submit, purchase) waits for your
approval.

> Status: early. macOS backend working; Windows and Linux backends planned. Agents run on Anthropic
> (Claude) or any OpenAI-compatible API (OpenAI, Grok, Gemini, Ollama).

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

Opens a desktop-style window (your installed Brave/Chrome in app mode) where you can create and edit
agents, connect Claude / OpenAI / Grok / Gemini / Ollama, run tasks and watch each step live, approve
or deny irreversible actions, and browse past runs and the full action log. The server listens on
127.0.0.1 only and every API call needs a per-launch token.

## Usage

```sh
npm run tool -- list                                   # all tools with base risk
npm run tool -- ui.dump_tree '{"app":"Notes","format":"text"}'
npm run agent -- mac-helper "Which app is frontmost?"  # Claude
npm run agent -- mac-helper-openai "Which app is frontmost?"  # OpenAI
npm run logs -- 20                                     # recent actions
npm test                                               # unit tests (no network, no LLM)
```

Irreversible tool calls prompt `y/N` in an interactive terminal and are denied otherwise.

## Project docs

- [CLAUDE.md](CLAUDE.md): goals, design principles, phase plan, invariants
- [docs/permissions.md](docs/permissions.md): macOS permissions and where to grant them
