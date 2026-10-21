# ADR 0003: Split into a containerized control plane and a native desktop runner

- **Status:** accepted (2026-10-19); protocol to be detailed and built in Phase 1

## Context
The user wants the backend in Docker. On macOS (and Windows), containers run in a Linux VM and cannot
reach the host desktop. That rules out AppleScript, the Accessibility API, synthetic keyboard/mouse,
screenshots, the microphone and speakers, the Apple GPU (MLX) and the overlay window. Desktop control is
deskpilot's core purpose. Mobile clients and more computers (Windows, Linux) are planned.

## Decision
Two parts:

1. **Control plane (Docker):** the FastAPI API, auth, run manager, agent loop, LLM calls, the safety
   core (validate → classify → approve → log), A.R.S.E.N.A.L's learning, Postgres.
2. **Desktop runner (native, one per computer):** `uv run deskpilot runner`. It connects *out* to the
   control plane, advertises the tools its OS supports, and executes only calls the control plane has
   already validated and approved. It hosts the Swift helpers, Playwright, the overlay, push-to-talk and
   speech. Ollama and voice models stay on the host (Apple GPU).

The runner is a security boundary. It must reject anything not issued through the approval path:
- paired device key
- signed, short-lived, single-use call tokens bound to (run, call id, tool, input hash)
- replay protection
- an allow-list of tools per runner
- it never accepts instructions from tool output

## Consequences
- Plus: the backend runs in Docker; several computers can be driven from one control plane; mobile
  talks to the same API; the safety core stays in one place.
- Minus: a second process and a protocol to secure and test; a local network hop per desktop action
  (milliseconds).
- The design and threat model go into docs/architecture/runner-protocol.md before implementation.
