// The desktop overlay: agents' avatars on a transparent page hosted by native/overlay (an
// always-on-top, click-through window). Avatars gather out of magic dust when they arrive and
// disintegrate back into it when they leave.
//
// Interactive: hovering shows a card (task, step, time, tokens) and the avatar looks at the cursor;
// clicking opens a bubble to reply, answer a question, approve (press and hold) or deny, change
// priority, stop, or open the run. Speech bubbles only ever show our own status wording; an agent's
// question (model output) appears in the click bubble, labelled as written by the AI, as plain text.
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Avatar } from "@/components/Avatar";
import { Orb } from "@/components/Orb";
import { api, get, presenceUrl } from "@/lib/api";
import { playDust } from "@/lib/dust";
import type { ArsenalDecision, PresenceAvatar, PresenceState, Priority, RunDetail } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Dust effect length; a bit shorter than the core's dissolveMs, so it ends before the avatar is removed. */
const DUST_MS = 1500;
/** Canvas space around the figure for the dust to fly into; matches .ov-dust in index.css. */
const DUST_PAD = { x: 50, top: 130, bottom: 10 };
/** Approve needs a press this long (the core checks too, OVERLAY_HOLD_MS). */
const HOLD_MS = 1000;

/** Messages to the native host (no-op in a normal browser tab). */
function host(msg: Record<string, unknown>): void {
  (window as unknown as { webkit?: { messageHandlers?: { deskpilot?: { postMessage(m: unknown): void } } } }).webkit?.messageHandlers?.deskpilot?.postMessage(msg);
}

type Reaction = "poke" | "cheer" | "nod" | null;

/** Presence moods → the orb's expressions. */
const ORB_STATE: Partial<Record<PresenceAvatar["mood"], "idle" | "thinking" | "talking" | "working" | "happy" | "worried">> = {
  talking: "talking",
  thinking: "thinking",
  working: "working",
  happy: "happy",
  frustrated: "worried",
  sad: "worried",
  worried: "worried",
};

function elapsed(since: number): string {
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Press and hold to approve: a quick click (or an agent's synthetic click) doesn't count. */
function HoldToApprove({ onApprove }: { onApprove: (heldMs: number) => void }) {
  const [progress, setProgress] = useState(0);
  const started = useRef<number | null>(null);
  const raf = useRef(0);
  const tick = () => {
    if (started.current === null) return;
    const p = Math.min(1, (performance.now() - started.current) / HOLD_MS);
    setProgress(p);
    if (p < 1) raf.current = requestAnimationFrame(tick);
  };
  const down = (e: PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    started.current = performance.now();
    raf.current = requestAnimationFrame(tick);
  };
  const up = (e: PointerEvent) => {
    e.stopPropagation();
    cancelAnimationFrame(raf.current);
    const held = started.current === null ? 0 : performance.now() - started.current;
    started.current = null;
    setProgress(0);
    if (held >= HOLD_MS) onApprove(Math.round(held));
  };
  return (
    <button type="button" className="ov-btn ov-approve" onPointerDown={down} onPointerUp={up} onPointerCancel={up} title="Press and hold to approve">
      <span className="ov-hold-fill" style={{ width: `${progress * 100}%` }} />
      <span className="ov-btn-label">{progress > 0 ? "keep holding…" : "Hold to approve"}</span>
    </button>
  );
}

/** Reply or answer box. While it's open the overlay has the keyboard and the core holds the desktop. */
function ReplyBox({
  placeholder,
  onSend,
  onClose,
  onText,
  sendLabel = "Send",
  closeOnSend = true,
  children,
}: {
  placeholder: string;
  onSend: (text: string) => Promise<void>;
  onClose: () => void;
  onText?: (text: string) => void;
  sendLabel?: string;
  /** false: the parent swaps the box out itself after sending. */
  closeOnSend?: boolean;
  children?: ReactNode;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  // Runs once per open box: a new onClose each render must not re-take the keyboard.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    let alive = true;
    // Take the desktop first (waits for any agent action in progress), then the keyboard.
    void api("POST", "/api/overlay/typing", { on: true })
      .then(() => {
        if (!alive) return;
        host({ type: "focus" });
        setReady(true);
        setTimeout(() => input.current?.focus(), 30);
      })
      .catch(() => close.current());
    const keepAlive = setInterval(() => void api("POST", "/api/overlay/typing", { on: true }).catch(() => {}), 30_000);
    return () => {
      alive = false;
      clearInterval(keepAlive);
      host({ type: "blur" });
      void api("POST", "/api/overlay/typing", { on: false }).catch(() => {});
    };
  }, []);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await onSend(text.trim());
      if (closeOnSend) onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ov-reply">
      <textarea
        ref={input}
        value={text}
        disabled={!ready || busy}
        placeholder={ready ? placeholder : "one moment…"}
        rows={2}
        onChange={(e) => {
          setText(e.target.value);
          onText?.(e.target.value);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
      {children}
      <div className="ov-row">
        <button type="button" className="ov-btn" onClick={onClose} onPointerDown={(e) => e.stopPropagation()}>
          Cancel
        </button>
        <button type="button" className="ov-btn ov-primary" disabled={!text.trim() || busy} onClick={() => void send()} onPointerDown={(e) => e.stopPropagation()}>
          {sendLabel}
        </button>
      </div>
    </div>
  );
}

/** A.R.S.E.N.A.L's bubble: give it a task (it shows who it would send, live), or open its page. */
function ArsenalBubble({ a, align, onClose, react }: { a: PresenceAvatar; align: "left" | "right"; onClose: () => void; react: (r: Reaction) => void }) {
  const [asking, setAsking] = useState(true);
  const [task, setTask] = useState("");
  const [preview, setPreview] = useState<ArsenalDecision | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (task.trim().length < 4) return setPreview(null);
    const t = setTimeout(() => {
      api<ArsenalDecision>("POST", "/api/arsenal/decide", { task })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 350);
    return () => clearTimeout(t);
  }, [task]);
  const stop = (e: PointerEvent) => e.stopPropagation();
  return (
    <div className={cn("ov-menu ov-arsenal", align === "right" ? "ov-menu-right" : "ov-menu-left")} data-hit onPointerDown={stop} onPointerUp={stop}>
      <div className="ov-menu-head">
        <b>A.R.S.E.N.A.L</b>
        <span>{a.status}</span>
      </div>
      {sent ? (
        <div className="ov-note">Sent {sent}. It runs alongside your other tasks; I'll learn from how it goes.</div>
      ) : asking ? (
        <>
          <div className="ov-label">What should I do?</div>
          <ReplyBox
            placeholder="Describe a task… (Enter to start, Esc to close)"
            sendLabel="Start"
            closeOnSend={false}
            onText={setTask}
            onClose={() => {
              setAsking(false);
              onClose();
            }}
            onSend={async (text) => {
              setError(null);
              try {
                const r = await api<{ runId: string; decision?: ArsenalDecision }>("POST", "/api/runs", { agent: "arsenal", task: text });
                setSent(r.decision?.agent ?? "it");
                react("cheer");
                setTimeout(onClose, 2500);
              } catch (e) {
                setError((e as Error).message);
                throw e;
              }
            }}
          >
            {preview && (
              <div className="ov-preview">
                → <b>{preview.agent}</b>
                {preview.connection ? ` on ${preview.connection}` : ""} · {preview.mode} · {Math.round(preview.confidence * 100)}% sure
                <div className="ov-preview-why">{preview.why[0]}</div>
              </div>
            )}
          </ReplyBox>
        </>
      ) : null}
      <div className="ov-row">
        <button type="button" className="ov-btn" onClick={() => host({ type: "openArsenal" })}>
          Open A.R.S.E.N.A.L
        </button>
      </div>
      {error && <div className="ov-error">{error}</div>}
    </div>
  );
}

/** The click bubble: everything you can do with this agent from the desktop. */
function ActionBubble({ a, align, onClose, react }: { a: PresenceAvatar; align: "left" | "right"; onClose: () => void; react: (r: Reaction) => void }) {
  const [mode, setMode] = useState<"menu" | "reply" | "answer">("menu");
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState<{ id: string; question: string; choices?: string[] } | null>(null);
  const runId = a.rootRunId;
  const live = !!runId && !a.leaving;

  useEffect(() => {
    if (a.pending?.kind !== "question" || !runId) return setQuestion(null);
    const id = a.pending.id;
    void get<RunDetail>(`/api/runs/${runId}`)
      .then((d) => setQuestion(d.pendingQuestions?.find((q) => q.id === id) ?? null))
      .catch(() => setQuestion(null));
  }, [a.pending, runId]);

  const act = async (fn: () => Promise<unknown>, reaction: Reaction, close = true) => {
    setError(null);
    try {
      await fn();
      react(reaction);
      if (close) onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const stop = (e: PointerEvent) => e.stopPropagation();

  return (
    <div className={cn("ov-menu", align === "right" ? "ov-menu-right" : "ov-menu-left")} data-hit onPointerDown={stop} onPointerUp={stop}>
      <div className="ov-menu-head">
        <b>{a.agent}</b>
        <span>{a.status}</span>
      </div>

      {mode === "menu" && (
        <>
          {a.pending?.kind === "approval" && (
            <div className="ov-section">
              <div className="ov-note">
                Wants to run <code>{a.pending.tool}</code>. Details are in the control panel.
              </div>
              <div className="ov-row">
                <HoldToApprove
                  onApprove={(heldMs) => void act(() => api("POST", `/api/runs/${runId}/approvals/${(a.pending as { id: string }).id}`, { approved: true, via: "overlay", heldMs }), "cheer")}
                />
                <button type="button" className="ov-btn ov-danger" onClick={() => void act(() => api("POST", `/api/runs/${runId}/approvals/${(a.pending as { id: string }).id}`, { approved: false, via: "overlay" }), "nod")}>
                  Deny
                </button>
              </div>
            </div>
          )}
          {a.pending?.kind === "question" && (
            <div className="ov-section">
              <div className="ov-label">Question · written by the AI</div>
              <div className="ov-question">{question ? question.question.slice(0, 300) : "…"}</div>
              {question?.choices?.length ? (
                <div className="ov-choices">
                  {question.choices.map((c) => (
                    <button key={c} type="button" className="ov-btn" onClick={() => void act(() => api("POST", `/api/runs/${runId}/questions/${question.id}`, { answer: c, via: "overlay" }), "nod")}>
                      {c}
                    </button>
                  ))}
                </div>
              ) : null}
              <button type="button" className="ov-btn ov-primary" onClick={() => setMode("answer")} disabled={!question}>
                Type an answer…
              </button>
            </div>
          )}
          {live && (
            <>
              <div className="ov-row">
                <button type="button" className="ov-btn ov-primary" onClick={() => setMode("reply")}>
                  Reply…
                </button>
                <button type="button" className="ov-btn" onClick={() => host({ type: "open", runId })}>
                  Open run
                </button>
                <button type="button" className="ov-btn ov-danger" onClick={() => void act(() => api("POST", `/api/runs/${runId}/stop`), null)}>
                  Stop
                </button>
              </div>
              {a.depth === 0 && (
                <div className="ov-row ov-prio">
                  <span>Priority</span>
                  {(["high", "normal", "low"] as Priority[]).map((p) => (
                    <button key={p} type="button" className="ov-btn ov-small" onClick={() => void act(() => api("POST", `/api/runs/${runId}/priority`, { priority: p }), "nod", false)}>
                      {p}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
      {mode === "reply" && (
        <ReplyBox
          placeholder={`Message ${a.agent}… (Enter to send, Esc to close)`}
          onClose={() => setMode("menu")}
          onSend={async (text) => {
            try {
              await api("POST", `/api/runs/${runId}/messages`, { text });
              react("nod");
            } catch (e) {
              setError((e as Error).message);
              throw e;
            }
          }}
        />
      )}
      {mode === "answer" && question && (
        <ReplyBox
          placeholder="Your answer… (Enter to send)"
          onClose={() => setMode("menu")}
          onSend={async (answer) => {
            try {
              await api("POST", `/api/runs/${runId}/questions/${question.id}`, { answer, via: "overlay" });
              react("nod");
            } catch (e) {
              setError((e as Error).message);
              throw e;
            }
          }}
        />
      )}
      {error && <div className="ov-error">{error}</div>}
    </div>
  );
}

function Slot({ a, open, onToggle }: { a: PresenceAvatar; open: boolean; onToggle: () => void }) {
  const drag = useRef<{ x: number; y: number; moved: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  /** The live (animated) avatar is visible; hidden while the dust stands in for it. */
  const [solid, setSolid] = useState(false);
  /** Plain fade used with "reduce motion", or if the dust effect can't run. */
  const [fade, setFade] = useState<"in" | "out" | null>(null);
  const [hover, setHover] = useState(false);
  const [gaze, setGaze] = useState(0);
  const [reaction, setReaction] = useState<Reaction>(null);
  const [, tick] = useState(0);

  // Arrive on mount; disintegrate when the core marks the avatar as leaving (and re-form if it's needed again).
  useEffect(() => {
    const mode = a.leaving ? "out" : "in";
    const fallback = () => {
      setFade(mode);
      setSolid(mode === "in");
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !svg.current || !canvas.current) {
      fallback();
      return;
    }
    setFade(null);
    return playDust({
      svg: svg.current,
      canvas: canvas.current,
      accent: a.look.accent,
      mode,
      ms: DUST_MS,
      pad: DUST_PAD,
      onStart: () => setSolid(false),
      onDone: (ok) => (ok ? setSolid(mode === "in") : fallback()),
    });
  }, [a.leaving, a.look.accent]);

  // The hover card's clock.
  useEffect(() => {
    if (!hover) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [hover]);

  const react = (r: Reaction) => {
    if (!r) return;
    setReaction(r);
    setTimeout(() => setReaction(null), 900);
  };

  const down = (e: PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.screenX, y: e.screenY, moved: 0 };
    host({ type: "dragStart" });
  };
  const move = (e: PointerEvent) => {
    const r = slot.current?.getBoundingClientRect();
    if (r) setGaze(Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width / 2))));
    const d = drag.current;
    if (!d) return;
    const dx = e.screenX - d.x;
    const dy = e.screenY - d.y;
    d.moved += Math.abs(dx) + Math.abs(dy);
    d.x = e.screenX;
    d.y = e.screenY;
    if (d.moved > 4) host({ type: "moveBy", dx, dy });
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    host({ type: "dragEnd" });
    if (d && d.moved <= 4) {
      react("poke");
      // The permanent orb opens its "what should I do?" bubble; a brief routing orb opens its task.
      if (a.kind === "orb" && a.key !== "arsenal") {
        if (a.rootRunId) host({ type: "open", runId: a.rootRunId });
      } else onToggle();
    }
  };

  // Bubbles open toward the middle of the screen so they stay inside the window.
  const align = (slot.current?.getBoundingClientRect().left ?? 0) > window.innerWidth / 2 ? "right" : "left";
  const waiting = a.pending !== undefined;

  return (
    <div
      ref={slot}
      className={cn("ov-slot", `ov-${a.mood}`, !solid && "ov-ghost", fade && `ov-fade-${fade}`, reaction && `ov-react-${reaction}`, waiting && "ov-waiting")}
      data-hit
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => {
        setHover(false);
        setGaze(0);
      }}
    >
      {open && solid && (a.key === "arsenal" ? <ArsenalBubble a={a} align={align} onClose={onToggle} react={react} /> : <ActionBubble a={a} align={align} onClose={onToggle} react={react} />)}
      {hover && !open && solid && (
        <div className={cn("ov-card", align === "right" ? "ov-menu-right" : "ov-menu-left")}>
          <b>{a.agent}</b>
          {a.task && <div className="ov-card-task">{a.task}</div>}
          <div className="ov-card-meta">{a.kind === "orb" ? a.status : `${a.status} · ${elapsed(a.startedAt)} · step ${a.steps} · ${a.outputTokens.toLocaleString()} tokens out`}</div>
          <div className="ov-card-hint">{a.key === "arsenal" ? "click to give me a task · drag to move" : a.kind === "orb" ? "click to open the task · drag to move" : "click for actions · drag to move"}</div>
        </div>
      )}
      <div className="ov-bubble">{a.status}</div>
      <div className="ov-figure">
        {a.kind === "orb" ? (
          <Orb svgRef={svg} color={a.color} state={ORB_STATE[a.mood] ?? "idle"} size={120} interactive title={`${a.agent}: ${a.status}`} />
        ) : (
          <Avatar svgRef={svg} look={a.look} mood={a.mood} size={120} gaze={hover ? gaze : 0} title={`${a.agent}, ${a.mood}`} />
        )}
        <canvas ref={canvas} className="ov-dust" aria-hidden />
      </div>
      <div className="ov-name">{a.agent}</div>
    </div>
  );
}

export function OverlayPage() {
  const [state, setState] = useState<PresenceState>({ avatars: [], hideForInput: false });
  const [openKey, setOpenKey] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.classList.add("overlay");
    const es = new EventSource(presenceUrl());
    es.addEventListener("presence", (m) => setState(JSON.parse((m as MessageEvent).data) as PresenceState));
    return () => {
      es.close();
      document.documentElement.classList.remove("overlay");
    };
  }, []);

  // A bubble whose avatar left closes with it.
  useEffect(() => {
    if (openKey && !state.avatars.some((a) => a.key === openKey && !a.leaving)) setOpenKey(null);
  }, [state, openKey]);

  // Tell the host where the avatars (and open bubbles) are: the window takes the mouse only there.
  useEffect(() => {
    let last = "";
    const report = () => {
      const rects = state.hideForInput
        ? []
        : [...document.querySelectorAll("[data-hit]")].map((el) => {
            const r = el.getBoundingClientRect();
            return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
          });
      const s = JSON.stringify(rects);
      if (s !== last) host({ type: "rects", rects });
      last = s;
    };
    report();
    const t = setInterval(report, 150);
    return () => clearInterval(t);
  }, [state, openKey]);

  const ordered = [...state.avatars].sort((x, y) => x.depth - y.depth);
  return (
    <div className={cn("ov-stage", state.hideForInput && "ov-hidden")}>
      {ordered.map((a) => (
        <Slot key={a.key} a={a} open={openKey === a.key} onToggle={() => setOpenKey((k) => (k === a.key ? null : a.key))} />
      ))}
    </div>
  );
}
