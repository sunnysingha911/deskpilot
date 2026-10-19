// A.R.S.E.N.A.L's avatar: a sphere built only from moving arcs, in any colour.
// With `interactive`, it responds to mouse, touch and keyboard: it leans toward the pointer, opens up
// when hovered or focused, ripples when tapped or on Enter/Space, spins up on a double tap, and
// "listens" (ticks pulse) while pressed and held. Arrow keys nudge where it looks.
// States show as: thinking = a scanning ring sweeping the sphere + data points orbiting it;
// working = a progress arc racing round the tick ring + faster orbits; interacting (hover, focus,
// touch) = targeting brackets that lock on and turn toward the pointer.
// About 14 arc tracks at different tilts and slightly different sizes give it a spherical, never
// perfectly round shape; on each track, arc segments travel along it while the track itself turns,
// each at its own speed and direction. A bright core sits inside, HUD arcs turn around the outside.
// Drawn as SVG; colours are attributes, per-arc timings are inline animation properties (CSSOM,
// allowed by the CSP), keyframes live in index.css.
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type Ref } from "react";
import { cn } from "@/lib/utils";

export type OrbState = "idle" | "thinking" | "talking" | "working" | "happy" | "worried";

function mix(hex: string, to: string, f: number): string {
  const a = parseInt(hex.slice(1), 16);
  const b = parseInt(to.slice(1), 16);
  const c = (s: number) => Math.round(((a >> s) & 255) * (1 - f) + ((b >> s) & 255) * f);
  return `#${((c(16) << 16) | (c(8) << 8) | c(0)).toString(16).padStart(6, "0")}`;
}

const CX = 60;
const CY = 78;
const R = 39;

/** SVG arc of a circle around the centre, from angle a0 to a1 (degrees, 0 = right, clockwise). */
function arc(r: number, a0: number, a1: number): string {
  const rad = (d: number) => (d * Math.PI) / 180;
  const x0 = CX + r * Math.cos(rad(a0));
  const y0 = CY + r * Math.sin(rad(a0));
  const x1 = CX + r * Math.cos(rad(a1));
  const y1 = CY + r * Math.sin(rad(a1));
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** A closed ellipse around the centre as a path (so dashes can travel along it). */
const ellipse = (rx: number, ry: number) => `M${CX - rx} ${CY} A${rx} ${ry} 0 1 0 ${CX + rx} ${CY} A${rx} ${ry} 0 1 0 ${CX - rx} ${CY}`;

/** Deterministic pseudo-random numbers, so the orb looks the same on every render. */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Track {
  rx: number;
  ry: number;
  tilt: number;
  dash: string;
  width: number;
  opacity: number;
  bright: boolean;
  spin: CSSProperties;
  flow: CSSProperties;
}

/** Data points orbiting the sphere (thinking / working): [tilt, flattening, seconds, start angle]. */
const ORBITERS: Array<[number, number, number, number]> = [
  [-24, 0.34, 3.2, 0],
  [38, 0.28, 4.1, 140],
  [96, 0.4, 2.7, 260],
];

const TRACKS: Track[] = (() => {
  const rnd = seeded(7);
  return Array.from({ length: 14 }, (_, i) => {
    const size = R * (0.84 + 0.18 * rnd()); // not a perfect circle: each track a little different
    const flat = 0.08 + 0.92 * ((i * 0.618 + rnd() * 0.3) % 1); // from edge-on to face-on
    // 1–3 arc segments per track, as a share of its length (pathLength = 100).
    const segs = 1 + Math.floor(rnd() * 3);
    const parts: number[] = [];
    let left = 100;
    for (let s = 0; s < segs; s++) {
      const on = 8 + rnd() * (s === 0 ? 34 : 18);
      const off = s === segs - 1 ? Math.max(6, left - on) : 6 + rnd() * 14;
      parts.push(on, off);
      left -= on + off;
    }
    return {
      rx: size,
      ry: size * flat,
      tilt: Math.round(i * 25.7 + rnd() * 18),
      dash: parts.map((p) => p.toFixed(1)).join(" "),
      width: 0.7 + rnd() * 1.9,
      opacity: 0.45 + rnd() * 0.55,
      bright: rnd() < 0.3,
      spin: { animationDuration: `${(14 + rnd() * 26).toFixed(1)}s`, animationDirection: i % 2 ? "reverse" : "normal", animationDelay: `-${(rnd() * 20).toFixed(1)}s` },
      flow: { animationDuration: `${(3 + rnd() * 7).toFixed(1)}s`, animationDirection: rnd() < 0.5 ? "reverse" : "normal", animationDelay: `-${(rnd() * 8).toFixed(1)}s` },
    };
  });
})();

export function Orb({
  color = "#ff8a1f",
  state = "idle",
  size = 120,
  className,
  title,
  svgRef,
  interactive,
  onActivate,
}: {
  color?: string;
  state?: OrbState;
  size?: number;
  className?: string;
  title?: string;
  svgRef?: Ref<SVGSVGElement>;
  /** React to pointer, touch and keyboard. */
  interactive?: boolean;
  /** Tap / click / Enter / Space. */
  onActivate?: () => void;
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [engaged, setEngaged] = useState(false); // hovered or focused
  const [look, setLook] = useState({ x: 0, y: 0 }); // -1 … 1, where it leans
  const [ripples, setRipples] = useState<number[]>([]);
  const [burst, setBurst] = useState(false);
  const [listening, setListening] = useState(false);
  const hold = useRef<NodeJS.Timeout | null>(null);
  const nudgeReset = useRef<NodeJS.Timeout | null>(null);
  const seq = useRef(0);
  useEffect(
    () => () => {
      if (hold.current) clearTimeout(hold.current);
      if (nudgeReset.current) clearTimeout(nudgeReset.current);
    },
    [],
  );

  const ripple = () => {
    const n = ++seq.current;
    setRipples((r) => [...r.slice(-3), n]);
    setTimeout(() => setRipples((r) => r.filter((x) => x !== n)), 950);
  };
  const lean = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const cy = r.top + (r.height * CY) / 170;
    setLook({ x: Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width / 2))), y: Math.max(-1, Math.min(1, (e.clientY - cy) / (r.width / 2))) });
  };
  const handlers = interactive
    ? {
        tabIndex: 0,
        role: "button" as const,
        onPointerEnter: () => setEngaged(true),
        onPointerLeave: () => {
          setEngaged(false);
          setLook({ x: 0, y: 0 });
          setListening(false);
          if (hold.current) clearTimeout(hold.current);
        },
        onPointerMove: lean,
        onPointerDown: (e: PointerEvent<SVGSVGElement>) => {
          lean(e);
          ripple();
          if (hold.current) clearTimeout(hold.current);
          hold.current = setTimeout(() => setListening(true), 550);
          // A parent may capture the pointer (the overlay's drag), so also catch the release here.
          window.addEventListener(
            "pointerup",
            () => {
              if (hold.current) clearTimeout(hold.current);
              setTimeout(() => setListening(false), 0);
            },
            { once: true },
          );
        },
        onPointerUp: () => {
          if (hold.current) clearTimeout(hold.current);
          const wasListening = listening;
          setListening(false);
          if (!wasListening) onActivate?.();
        },
        onPointerCancel: () => {
          if (hold.current) clearTimeout(hold.current);
          setListening(false);
        },
        onDoubleClick: () => {
          setBurst(true);
          setTimeout(() => setBurst(false), 1300);
        },
        onFocus: () => setEngaged(true),
        onBlur: () => {
          setEngaged(false);
          setLook({ x: 0, y: 0 });
        },
        onKeyDown: (e: KeyboardEvent<SVGSVGElement>) => {
          const step: Record<string, [number, number]> = { ArrowLeft: [-0.6, 0], ArrowRight: [0.6, 0], ArrowUp: [0, -0.6], ArrowDown: [0, 0.6] };
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            ripple();
            onActivate?.();
          } else if (step[e.key]) {
            e.preventDefault();
            const [dx, dy] = step[e.key]!;
            setLook((l) => ({ x: Math.max(-1, Math.min(1, l.x + dx)), y: Math.max(-1, Math.min(1, l.y + dy)) }));
            if (nudgeReset.current) clearTimeout(nudgeReset.current);
            nudgeReset.current = setTimeout(() => setLook({ x: 0, y: 0 }), 1600);
          } else if (e.key.toLowerCase() === "s") {
            setBurst(true);
            setTimeout(() => setBurst(false), 1300);
          }
        },
      }
    : { role: "img" as const };
  const shown: OrbState = listening ? "talking" : state;
  const light = mix(color, "#ffffff", 0.5);
  const hot = mix(color, "#fff4d6", 0.8);
  // A darker copy under each arc keeps them readable on light backgrounds too.
  const shade = mix(color, "#000000", 0.45);
  return (
    <svg
      ref={svgRef}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 120 170"
      width={size}
      height={(size * 170) / 120}
      className={cn("orb", `orb-${shown}`, interactive && "orb-interactive", engaged && "orb-engaged", burst && "orb-burst", listening && "orb-listening", className)}
      aria-label={title ?? (interactive ? "A.R.S.E.N.A.L: tap, or press Enter" : `A.R.S.E.N.A.L, ${state}`)}
      {...handlers}
    >
      <defs>
        <radialGradient id={`halo${id}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={color} stopOpacity="0.42" />
          <stop offset="60%" stopColor={color} stopOpacity="0.1" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </radialGradient>
        <filter id={`glow${id}`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.4" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <radialGradient id={`core${id}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="35%" stopColor={hot} />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </radialGradient>
      </defs>

      <ellipse cx={CX} cy="160" rx="24" ry="3.5" fill={color} opacity="0.22" className="orb-shadow" />
      <g className="orb-body">
        <circle cx={CX} cy={CY} r="58" fill={`url(#halo${id})`} className="orb-halo" />

        {/* outer HUD arcs */}
        <g className="orb-ring orb-ring-a" fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round">
          <path d={arc(53, -40, 25)} />
          <path d={arc(53, 85, 140)} />
          <path d={arc(53, 205, 262)} />
        </g>
        <g className="orb-ring orb-ring-ticks">
          <circle cx={CX} cy={CY} r="48" fill="none" stroke={shade} strokeWidth="3" strokeDasharray="1.4 3.6" opacity="0.2" />
          <circle cx={CX} cy={CY} r="48" fill="none" stroke={light} strokeWidth="2.2" strokeDasharray="0.9 4.1" opacity="0.65" className="orb-ticks" />
        </g>
        {/* working: a progress arc racing round the tick ring, with a fading tail */}
        <g className="orb-progress" fill="none" strokeLinecap="round" filter={`url(#glow${id})`}>
          <path d={arc(48, -90, -20)} stroke={hot} strokeWidth="3" />
          <path d={arc(48, -130, -90)} stroke={color} strokeWidth="2.4" opacity="0.5" />
          <path d={arc(48, -165, -130)} stroke={color} strokeWidth="1.8" opacity="0.2" />
        </g>

        {/* ripples from taps / Enter */}
        {ripples.map((n) => (
          <circle key={n} cx={CX} cy={CY} r={R} fill="none" stroke={hot} strokeWidth="2" className="orb-ripple" />
        ))}

        {/* the sphere: nothing but moving arcs (leans a little toward the pointer) */}
        <g transform={`translate(${(look.x * 3).toFixed(2)} ${(look.y * 3).toFixed(2)})`}>
        <g className="orb-orbits" fill="none" strokeLinecap="round">
          {TRACKS.map((t, i) => (
            <g key={i} className="orb-track" style={t.spin}>
              <g transform={`rotate(${t.tilt} ${CX} ${CY})`}>
                <path d={ellipse(t.rx, t.ry)} pathLength={100} stroke={shade} strokeWidth={t.width + 1.3} strokeDasharray={t.dash} opacity={0.22} className="orb-flow" style={t.flow} />
                <path d={ellipse(t.rx, t.ry)} pathLength={100} stroke={t.bright ? hot : i % 3 ? light : color} strokeWidth={t.width} strokeDasharray={t.dash} opacity={t.opacity} className="orb-flow" style={t.flow} />
              </g>
            </g>
          ))}
        </g>
        </g>

        {/* thinking: a scanning ring sweeping up and down the sphere */}
        <g className="orb-scan" fill="none" filter={`url(#glow${id})`}>
          <ellipse cx={CX} cy={CY} rx={R} ry={R * 0.26} stroke={hot} strokeWidth="1.6" opacity="0.9" />
          <ellipse cx={CX} cy={CY} rx={R} ry={R * 0.26} stroke={color} strokeWidth="4" opacity="0.25" />
        </g>

        {/* thinking / working: data points orbiting on tilted paths (SVG motion keeps them round) */}
        <g className="orb-orbiters">
          {ORBITERS.map(([tilt, flat, secs, start], i) => {
            const rx = R + 7;
            const ry = rx * flat;
            const path = `M${CX - rx} ${CY} A${rx} ${ry} 0 1 0 ${CX + rx} ${CY} A${rx} ${ry} 0 1 0 ${CX - rx} ${CY}`;
            return (
              <g key={i} transform={`rotate(${tilt} ${CX} ${CY})`}>
                <path d={path} fill="none" stroke={light} strokeWidth="0.6" opacity="0.25" strokeDasharray="2 3" />
                <circle r="2.4" fill={hot} filter={`url(#glow${id})`}>
                  <animateMotion dur={`${state === "working" ? secs * 0.5 : secs}s`} begin={`-${((start / 360) * secs).toFixed(2)}s`} repeatCount="indefinite" path={path} />
                </circle>
              </g>
            );
          })}
        </g>

        {/* interacting: targeting brackets that lock on and face the pointer */}
        <g className="orb-reticle" transform={`rotate(${((Math.atan2(look.y, look.x) * 180) / Math.PI).toFixed(1)} ${CX} ${CY})`} fill="none" strokeLinecap="round">
          <g className="orb-reticle-in">
            {/* outside the outer arcs, so they read clearly; the one facing the pointer is brightest */}
            <path d={arc(58, -20, 20)} stroke={color} strokeWidth="6" opacity="0.25" />
            <path d={arc(58, -20, 20)} stroke={hot} strokeWidth="2.8" />
            <path d={`M${CX + 55} ${CY - 20} L${CX + 61} ${CY - 22} M${CX + 55} ${CY + 20} L${CX + 61} ${CY + 22}`} stroke={hot} strokeWidth="2" />
            <path d={arc(58, 76, 104)} stroke={light} strokeWidth="2" opacity="0.65" />
            <path d={arc(58, 166, 194)} stroke={light} strokeWidth="2" opacity="0.45" />
            <path d={arc(58, 256, 284)} stroke={light} strokeWidth="2" opacity="0.65" />
            <circle cx={CX + 64} cy={CY} r="2" fill={hot} />
          </g>
        </g>

        {/* core: follows the pointer further than the sphere, like an eye */}
        <g transform={`translate(${(look.x * 7).toFixed(2)} ${(look.y * 7).toFixed(2)})`}>
          <circle cx={CX} cy={CY} r="19" fill={`url(#core${id})`} className="orb-core" />
          <g className="orb-ring orb-ring-core" fill="none" stroke={hot} strokeWidth="1.8" strokeLinecap="round">
            <path d={arc(12, 0, 70)} />
            <path d={arc(12, 120, 190)} />
            <path d={arc(12, 240, 310)} />
          </g>
          <circle cx={CX} cy={CY} r="3.6" fill="#ffffff" className="orb-core" />
        </g>

        <g className="orb-ring orb-ring-a">
          <circle cx={CX + 53} cy={CY} r="2.2" fill={hot} />
        </g>
      </g>
    </svg>
  );
}
