// The desktop overlay: agents' avatars on a transparent page hosted by native/overlay (an
// always-on-top, click-through window). Avatars gather out of magic dust when they arrive and
// disintegrate back into it when they leave. Status lines come from the core's presence feed (our own
// wording) and render as React text.
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Avatar } from "@/components/Avatar";
import { presenceUrl } from "@/lib/api";
import { playDust } from "@/lib/dust";
import type { PresenceAvatar, PresenceState } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Dust effect length; a bit shorter than the core's dissolveMs, so it ends before the avatar is removed. */
const DUST_MS = 1500;
/** Canvas space around the figure for the dust to fly into; matches .ov-dust in index.css. */
const DUST_PAD = { x: 50, top: 130, bottom: 10 };

/** Messages to the native host (no-op in a normal browser tab). */
function host(msg: Record<string, unknown>): void {
  (window as unknown as { webkit?: { messageHandlers?: { deskpilot?: { postMessage(m: unknown): void } } } }).webkit?.messageHandlers?.deskpilot?.postMessage(msg);
}

function Slot({ a }: { a: PresenceAvatar }) {
  const drag = useRef<{ x: number; y: number; moved: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  /** The live (animated) avatar is visible; hidden while the dust stands in for it. */
  const [solid, setSolid] = useState(false);
  /** Plain fade used with "reduce motion", or if the dust effect can't run. */
  const [fade, setFade] = useState<"in" | "out" | null>(null);

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

  const down = (e: PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.screenX, y: e.screenY, moved: 0 };
    host({ type: "dragStart" });
  };
  const move = (e: PointerEvent) => {
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
    if (d && d.moved <= 4 && a.rootRunId) host({ type: "open", runId: a.rootRunId });
  };

  return (
    <div
      className={cn("ov-slot", `ov-${a.mood}`, !solid && "ov-ghost", fade && `ov-fade-${fade}`)}
      data-hit
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      title={a.rootRunId ? `${a.agent}: click to open the run, drag to move` : a.agent}
    >
      <div className="ov-bubble">{a.status}</div>
      <div className="ov-figure">
        <Avatar svgRef={svg} look={a.look} mood={a.mood} size={120} title={`${a.agent}, ${a.mood}`} />
        <canvas ref={canvas} className="ov-dust" aria-hidden />
      </div>
      <div className="ov-name">{a.agent}</div>
    </div>
  );
}

export function OverlayPage() {
  const [state, setState] = useState<PresenceState>({ avatars: [], hideForInput: false });

  useEffect(() => {
    document.documentElement.classList.add("overlay");
    const es = new EventSource(presenceUrl());
    es.addEventListener("presence", (m) => setState(JSON.parse((m as MessageEvent).data) as PresenceState));
    return () => {
      es.close();
      document.documentElement.classList.remove("overlay");
    };
  }, []);

  // Tell the host where the avatars are: the window takes the mouse only there.
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
    const t = setInterval(report, 200);
    return () => clearInterval(t);
  }, [state]);

  const ordered = [...state.avatars].sort((x, y) => x.depth - y.depth);
  return (
    <div className={cn("ov-stage", state.hideForInput && "ov-hidden")}>
      {ordered.map((a) => (
        <Slot key={a.key} a={a} />
      ))}
    </div>
  );
}
