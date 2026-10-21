# Desktop runner: protocol and threat model

- **Status:** accepted (2026-10-19); §6 checks, signing and the policy file implemented with tests
  (`backend/src/deskpilot/runner/{protocol,gate,policy}.py`, `backend/tests/unit/test_runner_protocol.py`). Implements [ADR 0003](../adr/0003-control-plane-and-desktop-runner.md) in Phase 1.
- **Scope:** how the control plane (API in Docker) and a desktop runner (native process on a computer)
  pair, authenticate, exchange tool calls, and fail safely. What the runner refuses even if the control
  plane is wrong or compromised.

## 1. Parts and trust

```
 web / mobile / overlay ──HTTPS/SSE──►  CONTROL PLANE (Docker)                         RUNNER (native, per computer)
                                        API · auth · agent loop · LLM calls      WSS   tools that need the machine:
                                        safety core: validate → classify →   ◄───────  shell, AppleScript, ui.*, input.*,
                                        approve → log · Postgres              outbound  browser (Brave), screenshot,
                                        signing key (CP key)                  from      overlay, push-to-talk, speech
                                                                              runner    device key (Keychain) · local policy
                                                                                        · local audit log · desktop lock
```

| Party | Trusted for | Not trusted for |
|---|---|---|
| Control plane (CP) | deciding which calls are allowed (risk, approval, budgets), holding provider keys | anything the runner's **local policy** forbids; irreversible actions without an approval record |
| Runner | executing calls exactly as signed; reporting results honestly | deciding *what* to do (it never initiates actions itself) |
| AI model | proposing tool calls | everything else: its calls always pass the safety core |
| Tool output (screen, web, files) | nothing: it's data | never instructions (existing invariant, unchanged) |
| The user (web, overlay, phone) | approvals, tasks, pairing, policy | — |

## 2. Where each tool runs

| Runs in the **control plane** (no machine access needed) | Runs on the **runner** (needs the computer) |
|---|---|
| `plan.update`, `ask_user`, `agent.delegate`, `result.more`, `file.read` (attachments are stored by the CP) | `shell.run`, `applescript.run`, `ui.*`, `input.*`, `screenshot`, `browser.*` |

The CP keeps the full tool registry. A runner advertises which runner-side tools it supports on its OS
(macOS today; Windows/Linux runners advertise theirs). The registry offers an agent only the tools
available on its target runner (same rule as today's "only tools available on this OS").

## 3. Threats and answers

| # | Threat | Answer |
|---|---|---|
| T1 | Another program on the computer (malware, a web page in a browser) tries to make the runner act | **The runner listens on no port.** It only connects *out* to the CP. Nothing can call into it. |
| T2 | Something tries to pose as the runner to the CP, or as the CP to the runner | **Mutual authentication** with keys exchanged at pairing (Ed25519). The runner pins the CP's public key; the CP stores the runner's. |
| T3 | An old, approved call is captured and replayed | Each call carries a random **nonce**, an **expiry ≤ 30 s**, and is **single-use**: the runner remembers nonces until they expire. |
| T4 | A call is altered in transit (different command, different file) | Every call is **signed** over its canonical bytes (RFC 8785 JSON). Change one character and verification fails. |
| T5 | The model is tricked (prompt injection) into a harmful action | Unchanged safety core in the CP: risk classification + user approval for irreversible actions. Plus the runner **re-checks**: it classifies the call itself and refuses if its own risk is higher than the CP's (§6). |
| T6 | **The CP itself is buggy or compromised** (container, dependency, bad update) | Defence in depth on the runner: a **local policy** the CP cannot change (§7), local audit log, kill switch. Level 2 (§8): irreversible actions also need a signature from the *user's* device, which the CP can't forge. |
| T7 | Runner key stolen | Private key in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service), never in a file. **Revoke** a runner in the web app; pair again. Keys rotate on re-pairing. |
| T8 | Network sniffing / MITM (CP on another machine, phone on Wi-Fi) | Plain `ws://` is allowed **only on loopback** (127.0.0.1). Anything else must be `wss://` (TLS) plus the pinned keys above. |
| T9 | Runaway agent floods the desktop | Rate limits on the runner (calls/min per tool), per-call timeouts, output caps, `cancel` messages, and the desktop lock moves to the runner (it owns the screen). |
| T10 | Duplicate side effects after a disconnect | **No automatic retries** for `reversible`/`irreversible` calls: if the connection drops mid-call, the call ends as "unknown outcome" and the agent is told so. Only `read_only` calls may be retried. |
| T11 | Fake results from a rogue runner | Results are untrusted data anyway (they go to the model inside `<untrusted_data>`), and are signed for the audit trail. A revoked runner can't connect. |
| T12 | Someone near your desk pairs their own runner | Pairing needs a one-time code shown in the logged-in web app (or `deskpilot` CLI on the CP side), valid 5 minutes, single use, plus a fingerprint both sides display. |

Out of scope (stated so nobody assumes otherwise): a fully compromised OS account on the runner's
computer (malware with your user rights can already control your desktop without deskpilot).

## 4. Pairing (once per computer)

```
User                      Control plane                         Runner (on the computer)
 │  "Add computer"  ───────►  code = 8 chars, 5 min, single-use
 │  ◄─── shows code + CP key fingerprint
 │  runs: uv run deskpilot runner pair <cp-url> ─────────────────►  generates device key pair (Ed25519),
 │                                                                  stores private key in the OS keychain
 │                            ◄──── POST /api/v1/runners/pair {code, device_pub, label, os, version, tools}
 │                            verifies code (rate-limited), stores runner {id, device_pub, label, os, tools}
 │                            ────► {runner_id, cp_pub, cp_key_id}
 │                                                                  pins cp_pub; shows fingerprint
 │  confirms both fingerprints match (web app + terminal)  →  runner becomes "active"
```

Runner record in Postgres: `runners(id, label, os, device_pub, tools[], status: pending|active|revoked,
created_at, last_seen_at, version)`. CP signing key: Ed25519, stored in a Docker volume readable only by
the API user (or a Docker secret), with a `key_id` so it can rotate.

## 5. Session and messages

Transport: one WebSocket per runner, `GET /api/v1/runners/ws`, opened **by the runner**.

**Handshake (mutual challenge):**
1. CP → `hello {cp_key_id, cp_nonce, server_time}`
2. Runner → `auth {runner_id, runner_nonce, sig_device(cp_nonce ‖ runner_nonce ‖ "deskpilot-runner-v1")}`
3. CP verifies with the stored `device_pub` (and that the runner isn't revoked) →
   `welcome {session_id, sig_cp(runner_nonce ‖ cp_nonce ‖ session_id)}`
4. Runner verifies with the pinned `cp_pub`. Anything else, or > 5 s, closes the socket.

**Messages** (JSON; each signed by its sender over RFC 8785 canonical bytes, with `session_id` included,
so a message can't move to another session):

| Direction | Type | Fields (besides `type`, `session_id`, `sig`) |
|---|---|---|
| CP → R | `classify` | `call_id, tool, input` — for tools whose risk depends on live state (e.g. `ui.press` reads the button's label). Read-only on the runner; the CP uses the answer for its approval decision |
| R → CP | `classified` | `call_id, risk` |
| CP → R | `call` | `call_id, run_id, task {id, mode, priority}, tool, input, risk, approval {by, at, via} \| null, desktop, timeout_ms, issued_at, expires_at, nonce` |
| R → CP | `accepted` / `rejected` | `call_id`; `rejected` has a reason code (§6) |
| R → CP | `result` | `call_id, status ok\|error\|blocked, output, error, duration_ms, waited_ms` |
| CP → R | `cancel` | `call_id` (the runner stops the call: kills the process, releases the desktop) |
| R → CP | `event` | runner-originated state: `kind` = `voice_state {available, speaking, naturalVoiceError, pushToTalk}` (on connect and on change), `speaking {on}`, `listening`, `listen_end`, `voice_error {message}`. Transcripts never pass through here (they go from the overlay helper to the overlay page only); overlay "open run" is handled on the runner (it opens the panel window) |
| CP → R | `voice` | A.R.S.E.N.A.L's speech on this computer: `op` = `speak {text ≤ 700, engine, voice, rate}` · `stop` · `config {listen, hotkey, locale}` (push-to-talk, sent again on every connect) · `warm` · `voices` (with `call_id`). Not a tool call: it can only change what the speakers play. The runner re-checks every option (engine, voice name pattern, hotkey list, locale pattern, rate range) and never speaks while the mic listens; each `speak` is audited (length, not text). `runner start --no-speech / --no-overlay` turn it off locally |
| R → CP | `voice_info` | `call_id, system, natural` voices + the voice state |
| both | `ping` / `pong` | every 15 s; offline after 45 s silence |
| CP → R | `task_end` | `task_id`: the task finished; the runner releases what it held for it (e.g. its browser tabs). *Phase 2, with the agent loop.* |
| R → CP | `tools` | the runner's supported tools + versions (on connect and on change) |

Example call (signature shortened):
```json
{"type":"call","session_id":"s_7f…","call_id":"c_19","run_id":"run-2026-10-19-ab12",
 "task":{"id":"t_4","mode":"optimized","priority":"normal"},
 "tool":"shell.run","input":{"command":"ls ~/Documents | wc -l"},"risk":"read_only","approval":null,
 "desktop":false,"timeout_ms":30000,"issued_at":"2026-10-19T21:40:00.120Z",
 "expires_at":"2026-10-19T21:40:30.120Z","nonce":"Jd1…(128-bit)","sig":"ed25519:9a…"}
```

## 6. What the runner checks before running anything

In order; the first failure → `rejected {reason}` and an entry in the local audit log:

1. `bad_signature`: the signature verifies against the pinned CP key for this session.
2. `expired`: `now ≤ expires_at` and `expires_at − issued_at ≤ 30 s` (clock skew tolerance ±30 s; same
   machine in the common case).
3. `replayed`: the nonce hasn't been seen (kept until expiry).
4. `tool_not_allowed`: the tool is advertised by this runner **and** allowed by the local policy.
5. `invalid_input`: the input validates against the runner's own copy of the tool schema.
   `denied_by_policy`: a `shell.run` command matches one of the local policy's refused patterns.
6. `risk_mismatch`: the runner classifies the call with the same rules (shared `risk` module, same
   version). If its result is **higher** than the CP's `risk`, refuse (a CP bug or tampering tried to
   downgrade it).
7. `approval_missing`: `irreversible` calls need an `approval` record (`by` starts with `user:`). Level 2 (§8)
   additionally needs a user-device signature.
8. `paused`: the local kill switch is off-limits for everything but `read_only` (or for everything,
   if paused hard).
9. `rate_limited`: per-tool and global limits from the local policy.

Then: take the desktop lock if `desktop: true` (priority/mode as today), run with `timeout_ms`, cap the
output, send `result`. Every accepted, rejected and finished call goes to the local append-only audit log
(`data/runner/audit.jsonl`, rotated), independent of the CP's log.

## 7. Local policy (on the runner's computer, out of the CP's reach)

`data/runner/policy.toml`, created at pairing with safe defaults; the CP container has no access to it.
Changes need local access (edit, or `uv run deskpilot runner policy …`).

```toml
[tools]
allow = ["shell.run", "applescript.run", "ui.*", "input.*", "screenshot", "browser.*"]
deny  = []                              # e.g. ["applescript.run"] on a work machine

[shell]
# Regular expressions (case-insensitive), refused outright, approved or not. Patterns, not substrings:
# "rm -rf /" must not also refuse "rm -rf /tmp/build".
deny_patterns = ['(^|[\s;&|(`])sudo\b', '\brm\s+-[a-z]*r[a-z]*\s+/(\s|\*|$)', '\bdiskutil\s+(erase\w*|…)',
                 '\bcsrutil\b', '\blaunchctl\b', '\bnvram\b', '\bspctl\s+--master-disable', '\bmkfs…', '\bdd\b.*\bof=/dev/']

[limits]
calls_per_minute = 120
desktop_calls_per_minute = 60
max_output_bytes = 1_000_000

[safety]
paused = false                          # kill switch: only read-only actions run (`deskpilot runner pause`, or the overlay)
paused_hard = false                     # nothing runs at all
require_local_confirm = []              # e.g. ["shell.run"]: also ask in a native dialog on this Mac
touch_id_for_irreversible = false       # macOS: Touch ID before irreversible actions (decision 3: option, off)
```

## 8. Approval attestation levels

- **Level 1 (Phase 1):** the CP vouches for the approval (`approval.by = "user:gui" | "user:overlay"`)
  inside the signed call. It protects against everything except a compromised CP.
- **Level 2 (with mobile, Phase 7):** each user device (phone, the Mac's web app via passkey) has its own
  key (WebAuthn passkey / Secure Enclave), registered at pairing. Approving an irreversible action signs
  `hash(call_id ‖ tool ‖ canonical input)` with Face ID / Touch ID. The runner verifies that signature
  against the registered user-device keys. A compromised CP can then still *propose* actions but can't
  *authorize* irreversible ones.
- Voice never approves (existing invariant). Overlay approvals keep the held-press + quiet-desktop rule;
  the runner reports desktop activity, so the "quiet" check uses the machine's real state.

## 9. Failure behaviour

| Situation | Behaviour |
|---|---|
| Runner offline when a call is due | Call fails fast with "computer offline"; read-only calls may wait up to 10 s for a reconnect |
| Disconnect during a non-read-only call | Outcome "unknown"; never retried automatically; the agent is told; the runner's audit log has the truth |
| CP restarts | Runner reconnects with backoff (1 s → 30 s); in-flight calls are cancelled on the runner |
| Signature/expiry/replay failure | Rejected, logged on both sides, surfaced in the run timeline |
| Revoked runner | Socket closed; reconnects refused; runner shows "revoked: pair again" |

## 10. Implementation outline (Phase 1)

```
backend/src/deskpilot/runner/
  protocol.py     pydantic message models, RFC 8785 canonical JSON, Ed25519 sign/verify (cryptography)
  keys.py         device key in the OS keychain (keyring); CP key load/rotate
  policy.py       policy.toml load + checks (§6, §7)
  client.py       the runner process: connect, handshake, verify, execute via tools/, audit log
  pairing.py      `deskpilot runner pair|pause|resume|status`
backend/src/deskpilot/api/
  runners.py      pairing endpoints, runner registry, the WebSocket hub, call dispatch + cancel
```

New dependencies: `cryptography` (Ed25519), `keyring` (OS keychain), `rfc8785` (canonical JSON; or a
small in-house implementation with tests).

## 11. Tests (written before the code they cover)
- **Protocol unit tests:** each §6 rejection reason has a test (tampered input, wrong key, expired,
  replayed nonce, unknown tool, risk downgraded, irreversible without approval, paused, rate-limited).
- **Pairing:** wrong / expired / reused code; fingerprint mismatch; revoked runner can't connect.
- **Integration:** a real CP (test DB) + runner over WebSocket on loopback: read-only call, approved
  irreversible call, cancel mid-call, disconnect mid-call (no retry), reconnect.
- **Property tests:** canonicalization round-trips; any single-byte change breaks the signature.
- The existing tool tests run unchanged through the runner.

## 12. Decisions for review
1. **`shell.run` runs on the runner** (on your Mac, as today), not in the container. Recommended: agents
   are meant to work on your computer. A sandboxed "container shell" could be added later as a separate,
   safer tool.
2. **Local policy defaults** (§7): OK to ship the `deny_patterns` list and limits as written?
3. **Level 2 approvals** (§8) arrive with mobile (Phase 7). Should irreversible actions on the Mac also
   ask for **Touch ID** before then (macOS LocalAuthentication via the Swift helper)? Recommended as an
   option, off by default.
4. **New dependencies:** `cryptography`, `keyring`, `rfc8785`.
