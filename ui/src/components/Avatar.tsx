// Stylized game-hero avatar (chunky proportions, ink outlines, cel shading), drawn as SVG so the desktop
// overlay and the control panel share one look. Original designs; colours are SVG attributes (allowed by
// the page's strict CSP); animations live in index.css.
import { useId, type ReactNode, type Ref } from "react";
import type { AvatarLook } from "../../../src/agent/schema.ts";
import { cn } from "@/lib/utils";

export type Mood = "idle" | "thinking" | "working" | "talking" | "waiting" | "worried" | "asking" | "sad" | "happy" | "frustrated" | "waving";
export const MOOD_LIST: Mood[] = ["idle", "thinking", "working", "talking", "waiting", "worried", "asking", "sad", "frustrated", "happy", "waving"];

export const SKIN: Record<AvatarLook["skin"], { base: string; shade: string }> = {
  porcelain: { base: "#fde3d0", shade: "#efc3a4" },
  light: { base: "#f3c9a6", shade: "#dda781" },
  tan: { base: "#dca377", shade: "#c2855a" },
  olive: { base: "#c48a5a", shade: "#a56f43" },
  brown: { base: "#8f5b3b", shade: "#73462c" },
  deep: { base: "#5e3b27", shade: "#472b1b" },
};

const INK = "#1d1626";
const OL = { stroke: INK, strokeWidth: 2.2, strokeLinejoin: "round" as const };

/** Mix #rrggbb `hex` toward `to` by f (0..1). */
function mix(hex: string, to: string, f: number): string {
  const a = parseInt(hex.slice(1), 16);
  const b = parseInt(to.slice(1), 16);
  const c = (s: number) => Math.round(((a >> s) & 255) * (1 - f) + ((b >> s) & 255) * f);
  return `#${((c(16) << 16) | (c(8) << 8) | c(0)).toString(16).padStart(6, "0")}`;
}
const darken = (hex: string, f = 0.78) => mix(hex, "#000000", 1 - f);
const lighten = (hex: string, f: number) => mix(hex, "#ffffff", f);

// ── Body (viewBox 0 0 120 170) ───────────────────────────────────────────────
const TORSO = "M36 90 Q60 82 84 90 Q92 93 92 103 L87 133 L33 133 L28 103 Q28 93 36 90 Z";
const ROBE = "M36 90 Q60 82 84 90 Q92 93 92 103 L98 156 Q60 162 22 156 L28 103 Q28 93 36 90 Z";

interface Kit {
  torso: string;
  sleeve: string;
  pants: string;
  boots: string;
  sole: string;
  hands?: string;
}
function kit(look: AvatarLook): Kit {
  const s = look.shirt;
  switch (look.outfit) {
    case "tactical":
      return { torso: s, sleeve: s, pants: "#4a503f", boots: "#2b241f", sole: "#120f0c" };
    case "armor":
      return { torso: s, sleeve: darken(s, 0.5), pants: darken(s, 0.45), boots: lighten(s, 0.15), sole: darken(s, 0.4), hands: "#a3adbb" };
    case "jacket":
      return { torso: s, sleeve: s, pants: "#344a74", boots: "#1f1f24", sole: "#f4f4f5" };
    case "robe":
      return { torso: s, sleeve: s, pants: darken(s, 0.6), boots: "#3b2a20", sole: "#1d1410" };
    case "suit":
      return { torso: s, sleeve: s, pants: s, boots: "#e5e7eb", sole: "#9ca3af", hands: "#e5e7eb" };
    default:
      return { torso: s, sleeve: s, pants: "#2b2f3a", boots: "#f4f4f5", sole: look.accent };
  }
}

function BackGear({ look }: { look: AvatarLook }) {
  const a = look.accent;
  switch (look.back) {
    case "pack":
      return (
        <g>
          <rect x="37" y="80" width="46" height="50" rx="10" fill="#4b4b55" {...OL} />
          <path d="M42 86 L78 86" stroke={a} strokeWidth="3" strokeLinecap="round" />
        </g>
      );
    case "jetpack":
      return (
        <g>
          {[24, 80].map((x) => (
            <g key={x}>
              <path className="av-flame" d={`M${x + 3} 122 Q${x + 8} 146 ${x + 13} 122 Z`} fill={a} />
              <path className="av-flame" d={`M${x + 5.5} 122 Q${x + 8} 136 ${x + 10.5} 122 Z`} fill="#fff7c2" />
              <rect x={x} y="78" width="16" height="44" rx="7" fill="#a1a8b5" {...OL} />
              <path d={`M${x + 4} 86 L${x + 4} 112`} stroke="#ffffff" strokeOpacity="0.5" strokeWidth="2.5" strokeLinecap="round" />
              <rect x={x + 2} y="118" width="12" height="6" rx="2" fill="#4b5563" {...OL} strokeWidth="1.6" />
            </g>
          ))}
        </g>
      );
    case "wings":
      return (
        <g fill={a} fillOpacity="0.4" stroke={a} strokeWidth="1.8" strokeLinejoin="round">
          <g className="av-flap-l">
            <path d="M54 98 Q34 54 12 58 Q0 64 6 80 Q12 94 52 102 Z" />
            <path d="M52 104 Q22 102 14 114 Q12 126 26 124 Q42 120 54 106 Z" />
            <path d="M50 99 Q32 76 16 68 M50 105 Q34 110 22 118" fill="none" strokeOpacity="0.7" />
          </g>
          <g className="av-flap-r">
            <path d="M66 98 Q86 54 108 58 Q120 64 114 80 Q108 94 68 102 Z" />
            <path d="M68 104 Q98 102 106 114 Q108 126 94 124 Q78 120 66 106 Z" />
            <path d="M70 99 Q88 76 104 68 M70 105 Q86 110 98 118" fill="none" strokeOpacity="0.7" />
          </g>
        </g>
      );
    case "cape":
      return (
        <path className="av-cape" d="M34 90 Q60 84 86 90 L102 156 Q60 166 18 156 Z" fill={darken(look.shirt, 0.55)} stroke={a} strokeWidth="2.6" strokeLinejoin="round" />
      );
    case "shield":
      return (
        <g>
          <circle cx="29" cy="100" r="21" fill="#a3adbb" {...OL} />
          <circle cx="29" cy="100" r="14" fill={darken(look.shirt, 0.8)} stroke={INK} strokeWidth="1.6" />
          <path d="M29 90 L36 100 L29 110 L22 100 Z" fill={a} stroke={INK} strokeWidth="1.4" />
        </g>
      );
    default:
      return null;
  }
}

function OutfitDetails({ look }: { look: AvatarLook }) {
  const s = look.shirt;
  const a = look.accent;
  switch (look.outfit) {
    case "hoodie":
      return (
        <g>
          <path d="M43 116 L77 116 L81 133 L39 133 Z" fill={darken(s, 0.85)} stroke={INK} strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M54 93 L53 107 M66 93 L67 107" stroke="#f4f4f5" strokeWidth="2" strokeLinecap="round" />
          <circle cx="53" cy="108" r="1.8" fill={a} />
          <circle cx="67" cy="108" r="1.8" fill={a} />
        </g>
      );
    case "tactical":
      return (
        <g>
          <path d="M38 91 Q60 86 82 91 L85 128 L35 128 Z" fill={darken(s, 0.5)} stroke={INK} strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M42 92 L80 124" stroke="#2b2f22" strokeWidth="4" />
          {[40, 55, 70].map((x) => (
            <rect key={x} x={x} y="110" width="10" height="11" rx="2" fill="#5b6148" stroke={INK} strokeWidth="1.4" />
          ))}
          <rect x="33" y="126" width="54" height="6" fill="#1f2125" stroke={INK} strokeWidth="1.4" />
          <rect x="56" y="125.5" width="8" height="7" rx="1.5" fill={a} stroke={INK} strokeWidth="1.2" />
        </g>
      );
    case "armor":
      return (
        <g>
          <path d="M38 94 Q60 87 82 94 L78 118 Q60 127 42 118 Z" fill={lighten(s, 0.25)} stroke={INK} strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M44 122 L76 122 M46 128 L74 128" stroke={darken(s, 0.6)} strokeWidth="2" strokeLinecap="round" />
          <circle cx="60" cy="105" r="7" fill={darken(s, 0.5)} stroke={INK} strokeWidth="1.6" />
          <circle className="av-glow" cx="60" cy="105" r="4" fill={a} />
        </g>
      );
    case "jacket":
      return (
        <g>
          <path d="M52 87 L68 87 L66 133 L54 133 Z" fill="#f5f5f4" stroke={INK} strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M60 99 L65 108 L55 108 Z" fill={a} />
          <path d="M52 87 L45 104 L54 99 Z M68 87 L75 104 L66 99 Z" fill={darken(s, 0.75)} stroke={INK} strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M33 126 L52 126 M68 126 L87 126" stroke={darken(s, 0.6)} strokeWidth="3" />
        </g>
      );
    case "robe":
      return (
        <g>
          <path d="M48 88 L60 104 L72 88" stroke={a} strokeWidth="2.6" fill="none" strokeLinejoin="round" />
          <path d="M29 118 Q60 126 91 118 L92 126 Q60 135 28 126 Z" fill={a} stroke={INK} strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M23 150 Q60 157 97 150" stroke={a} strokeWidth="3" fill="none" />
          <path d="M60 132 L60 156" stroke={darken(s, 0.7)} strokeWidth="2" />
        </g>
      );
    case "suit":
      return (
        <g>
          <path d="M33 104 L87 104" stroke={a} strokeWidth="3" />
          <circle cx="73" cy="96" r="3.6" fill={a} stroke={INK} strokeWidth="1.2" />
          <rect x="33" y="124" width="54" height="5" fill={darken(s, 0.6)} stroke={INK} strokeWidth="1.2" />
        </g>
      );
    default:
      return null;
  }
}

/** Collar pieces that sit over the neck (drawn after it). */
function Collar({ look }: { look: AvatarLook }) {
  if (look.outfit === "hoodie") {
    return <path d="M36 92 Q40 77 60 80 Q80 77 84 92 Q60 99 36 92 Z" fill={darken(look.shirt, 0.8)} {...OL} />;
  }
  if (look.outfit === "suit") return <ellipse cx="60" cy="89" rx="15" ry="4.5" fill="#d1d5db" {...OL} />;
  if (look.outfit === "jacket") return <path d="M46 88 Q60 80 74 88 L70 92 Q60 87 50 92 Z" fill={darken(look.shirt, 0.7)} {...OL} strokeWidth="1.6" />;
  return null;
}

function Legs({ k, look }: { k: Kit; look: AvatarLook }) {
  return (
    <g>
      {look.outfit !== "robe" && (
        <g fill={k.pants} {...OL}>
          <path d="M37 130 L58 130 L57 153 L40 153 Z" />
          <path d="M62 130 L83 130 L80 153 L63 153 Z" />
        </g>
      )}
      {look.outfit === "suit" && (
        <g fill={darken(look.shirt, 0.75)} stroke={INK} strokeWidth="1.2">
          <rect x="42" y="137" width="13" height="7" rx="2" />
          <rect x="65" y="137" width="13" height="7" rx="2" />
        </g>
      )}
      {look.outfit === "tactical" && <path d="M41 140 L55 140 M65 140 L79 140" stroke="#383d30" strokeWidth="5" />}
      <g fill={k.boots} {...OL}>
        <path d="M39 150 L57 150 Q59 158 57 162 L35 162 Q33 154 39 150 Z" />
        <path d="M63 150 L81 150 Q87 154 85 162 L63 162 Q61 158 63 150 Z" />
      </g>
      <path d="M36 160 L57 160 M63 160 L84 160" stroke={k.sole} strokeWidth="2.6" />
    </g>
  );
}

type ArmPose = { d: string; hand: [number, number]; className?: string };
function arms(mood: Mood): { left: ArmPose; right: ArmPose } {
  const left: ArmPose = { d: "M33 96 Q26 112 27 128", hand: [27, 131] };
  const right: ArmPose = { d: "M87 96 Q94 112 93 128", hand: [93, 131] };
  switch (mood) {
    case "working":
      return { left: { d: "M33 96 Q28 116 44 121", hand: [47, 120] }, right: { d: "M87 96 Q92 116 76 121", hand: [73, 120] } };
    case "waving":
      return { left, right: { d: "M87 96 Q100 84 101 67", hand: [101, 62], className: "av-wave" } };
    case "worried":
    case "asking":
      return { left, right: { d: "M87 96 Q99 88 97 75", hand: [97, 70], className: "av-raise" } };
    case "thinking":
      return { left, right: { d: "M87 96 Q94 106 74 86", hand: [71, 82] } };
    case "happy":
      return { left: { d: "M33 96 Q20 86 20 72", hand: [20, 67], className: "av-cheer" }, right: { d: "M87 96 Q100 86 100 72", hand: [100, 67], className: "av-cheer" } };
    default:
      return { left, right };
  }
}

function Arm({ pose, k, look }: { pose: ArmPose; k: Kit; look: AvatarLook }) {
  const [hx, hy] = pose.hand;
  return (
    <g className={pose.className}>
      <path d={pose.d} stroke={INK} strokeWidth="14" strokeLinecap="round" fill="none" />
      <path d={pose.d} stroke={k.sleeve} strokeWidth="9.6" strokeLinecap="round" fill="none" />
      <circle cx={hx} cy={hy} r="6.4" fill={k.hands ?? SKIN[look.skin].base} {...OL} />
    </g>
  );
}

function Pauldrons({ look }: { look: AvatarLook }) {
  if (look.outfit !== "armor") return null;
  return (
    <g>
      {[30, 90].map((x) => (
        <g key={x}>
          <ellipse cx={x} cy="95" rx="11" ry="9" fill={darken(look.shirt, 0.85)} {...OL} />
          <path d={`M${x - 7} 92 Q${x} 88 ${x + 7} 92`} stroke={look.accent} strokeWidth="2.2" fill="none" strokeLinecap="round" />
        </g>
      ))}
    </g>
  );
}

function Holo({ look }: { look: AvatarLook }) {
  return (
    <g className="av-holo">
      <rect x="42" y="98" width="36" height="20" rx="3" fill={look.accent} fillOpacity="0.28" stroke={look.accent} strokeWidth="1.5" />
      <path d="M46 104 L64 104 M46 109 L72 109 M46 114 L58 114" stroke={look.accent} strokeWidth="1.6" strokeLinecap="round" />
    </g>
  );
}

// ── Head (drawn in its own 120×150 space, then scaled onto the body) ─────────
function HairBack({ look }: { look: AvatarLook }) {
  const c = look.hairColor;
  switch (look.hair) {
    case "long":
      return <path d="M27 62 Q24 112 38 122 L82 122 Q96 112 93 62 Z" fill={c} {...OL} />;
    case "ponytail":
      return <path d="M86 46 Q114 52 106 96 Q102 112 94 106 Q100 80 84 60 Z" fill={c} {...OL} />;
    case "bun":
      return <circle cx="60" cy="24" r="12" fill={c} {...OL} />;
    case "afro":
      return <ellipse cx="60" cy="50" rx="41" ry="35" fill={c} {...OL} />;
    default:
      return null;
  }
}

function HairFront({ look }: { look: AvatarLook }) {
  const c = look.hairColor;
  const shine = <path d="M42 36 Q50 31 58 32" stroke="#ffffff" strokeOpacity="0.35" strokeWidth="2.5" fill="none" strokeLinecap="round" />;
  switch (look.hair) {
    case "spiky":
      return (
        <g>
          <path d="M28 64 L25 40 L36 44 L33 26 L46 33 L49 15 L60 29 L71 13 L74 32 L87 25 L84 42 L95 40 L92 64 Q86 44 72 42 Q60 50 46 42 Q34 46 28 64 Z" fill={c} {...OL} />
          {shine}
        </g>
      );
    case "swoop":
      return (
        <g>
          <path d="M29 62 Q26 24 62 22 Q96 24 92 60 Q90 42 80 38 Q64 58 36 52 Q32 56 29 62 Z" fill={c} {...OL} />
          {shine}
        </g>
      );
    case "short":
      return (
        <g>
          <path d="M30 60 Q29 26 60 26 Q91 26 90 60 Q85 42 71 40 Q60 47 45 42 Q34 47 30 60 Z" fill={c} {...OL} />
          {shine}
        </g>
      );
    case "buzz":
      return <path d="M31 54 Q32 28 60 28 Q88 28 89 54 Q76 38 60 38 Q44 38 31 54 Z" fill={c} opacity="0.9" />;
    case "curly":
      return (
        <g fill={c} {...OL} strokeWidth="1.8">
          {[[33, 50, 9], [38, 38, 10], [48, 30, 10], [60, 27, 10], [72, 30, 10], [82, 38, 10], [87, 50, 9], [54, 38, 8], [67, 38, 8]].map(([x, y, r]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r={r} />
          ))}
        </g>
      );
    case "long":
      return <path d="M28 74 Q25 27 60 26 Q95 27 92 74 Q89 46 76 40 Q62 49 44 42 Q32 50 28 74 Z" fill={c} {...OL} />;
    case "bun":
    case "ponytail":
      return <path d="M30 57 Q31 28 60 28 Q89 28 90 57 Q80 40 60 40 Q40 40 30 57 Z" fill={c} {...OL} />;
    case "afro":
      return <path d="M34 50 Q40 36 60 36 Q80 36 86 50 Q72 44 60 44 Q48 44 34 50 Z" fill={darken(c, 0.9)} />;
    case "mohawk":
      return (
        <g fill={c}>
          <path d="M33 52 Q34 32 60 30 Q86 32 87 52 Q74 40 60 40 Q46 40 33 52 Z" opacity="0.3" />
          <path d="M52 40 Q54 4 60 2 Q66 4 68 40 Z" {...OL} />
        </g>
      );
    default:
      return null;
  }
}

function Headgear({ look }: { look: AvatarLook }) {
  const a = look.accent;
  switch (look.accessory) {
    case "visor":
      return (
        <g>
          <path d="M28 62 L34 62 M86 62 L92 62" stroke="#27272a" strokeWidth="4" />
          <rect className="av-glow" x="33" y="54" width="54" height="17" rx="8.5" fill={a} fillOpacity="0.5" {...OL} />
          <path d="M40 58.5 L55 58.5" stroke="#ffffff" strokeOpacity="0.8" strokeWidth="2.2" strokeLinecap="round" />
        </g>
      );
    case "goggles":
      return (
        <g>
          <path d="M29 47 Q60 35 91 47" stroke="#27272a" strokeWidth="5" fill="none" />
          {[47, 73].map((x) => (
            <g key={x}>
              <circle cx={x} cy="41" r="8.5" fill={a} fillOpacity="0.75" stroke="#27272a" strokeWidth="3.4" />
              <path d={`M${x - 4} 38 Q${x - 2} 35 ${x + 1} 35`} stroke="#ffffff" strokeOpacity="0.8" strokeWidth="1.8" fill="none" strokeLinecap="round" />
            </g>
          ))}
        </g>
      );
    case "helmet":
      return (
        <g>
          <path d="M24 72 Q22 17 60 15 Q98 17 96 72 L88 80 L86 56 Q80 40 60 40 Q40 40 34 56 L32 80 Z" fill="#8b95a5" {...OL} strokeWidth="2.4" />
          <path d="M30 40 Q34 26 46 20" stroke="#ffffff" strokeOpacity="0.45" strokeWidth="3" fill="none" strokeLinecap="round" />
          <path d="M60 15 L60 40" stroke={a} strokeWidth="3.5" />
          <circle cx="29" cy="66" r="5" fill={a} stroke={INK} strokeWidth="1.6" />
          <circle cx="91" cy="66" r="5" fill={a} stroke={INK} strokeWidth="1.6" />
        </g>
      );
    case "hood":
      return (
        <path d="M22 98 Q14 20 60 16 Q106 20 98 98 Q96 70 88 52 Q76 36 60 36 Q44 36 32 52 Q24 70 22 98 Z" fill={darken(look.shirt, 0.75)} {...OL} strokeWidth="2.4" />
      );
    case "crown":
      return (
        <g className="av-float">
          <path d="M42 24 L44 8 L52 17 L60 3 L68 17 L76 8 L78 24 Z" fill="#facc15" {...OL} />
          <circle cx="60" cy="17" r="2.6" fill={a} />
          <path d="M43 24 L77 24" stroke="#b45309" strokeWidth="2" />
        </g>
      );
    case "glasses":
      return (
        <g stroke={INK} strokeWidth="2.2" fill="#ffffff" fillOpacity="0.18">
          <rect x="38" y="57" width="19" height="14" rx="4" />
          <rect x="63" y="57" width="19" height="14" rx="4" />
          <path d="M57 63 L63 63" fill="none" />
        </g>
      );
    case "sunglasses":
      return (
        <g fill="#111827" stroke={INK} strokeWidth="1.6">
          <path d="M37 57 L58 57 L56 69 Q47 72 39 68 Z" />
          <path d="M62 57 L83 57 L81 68 Q73 72 64 69 Z" />
          <path d="M58 60 L62 60" />
          <path d="M41 60 L48 60" stroke={a} strokeOpacity="0.8" strokeWidth="1.6" />
        </g>
      );
    case "headset":
      return (
        <g>
          <path d="M29 60 Q29 19 60 19 Q91 19 91 60" stroke="#27272a" strokeWidth="5" fill="none" />
          <rect x="22" y="53" width="11" height="19" rx="4" fill="#3f3f46" {...OL} strokeWidth="1.8" />
          <rect x="87" y="53" width="11" height="19" rx="4" fill="#3f3f46" {...OL} strokeWidth="1.8" />
          <path d="M25 58 L25 67 M95 58 L95 67" stroke={a} strokeWidth="2" strokeLinecap="round" />
          <path d="M28 70 Q32 88 50 88" stroke="#27272a" strokeWidth="2.6" fill="none" />
          <circle cx="51" cy="88" r="3" fill={a} stroke={INK} strokeWidth="1.2" />
        </g>
      );
    case "cap": {
      const c = darken(look.shirt, 0.85);
      return (
        <g>
          <path d="M28 52 Q29 20 60 20 Q91 20 92 52 Z" fill={c} {...OL} />
          <path d="M60 47 Q102 44 112 54 Q94 57 60 53 Z" fill={darken(c, 0.8)} {...OL} />
          <circle cx="60" cy="34" r="4" fill={a} />
        </g>
      );
    }
    case "beanie": {
      const c = darken(look.shirt, 0.9);
      return (
        <g>
          <path d="M28 54 Q29 16 60 16 Q91 16 92 54 Z" fill={c} {...OL} />
          <rect x="27" y="45" width="66" height="10" rx="4" fill={darken(c, 0.8)} {...OL} strokeWidth="1.8" />
          <circle cx="60" cy="14" r="6" fill={a} {...OL} strokeWidth="1.8" />
        </g>
      );
    }
    case "earrings":
      return (
        <g fill={a} stroke={INK} strokeWidth="1">
          <circle cx="30" cy="74" r="2.8" />
          <circle cx="90" cy="74" r="2.8" />
        </g>
      );
    default:
      return null;
  }
}

function Eyes({ mood, gaze = 0 }: { mood: Mood; gaze?: number }) {
  if (mood === "happy" || mood === "waving") {
    return (
      <g stroke={INK} strokeWidth="3" fill="none" strokeLinecap="round">
        <path d="M41 66 Q47 57 53 66" />
        <path d="M67 66 Q73 57 79 66" />
      </g>
    );
  }
  const shape: Record<string, [number, number, number]> = {
    // [pupil dx, pupil dy, eye height]
    thinking: [2, -2.4, 6.4],
    working: [0, 2, 5],
    waiting: [-2.4, 0, 6.4],
    worried: [0, 0, 7.6],
    asking: [1.2, -1.4, 7.4],
    sad: [0, 2, 5.8],
    frustrated: [0, 0.6, 3.8],
  };
  const [mdx, dy, ry] = shape[mood] ?? [0, 0, 6.6];
  // gaze (-1 … 1) turns the eyes toward the cursor.
  const dx = Math.max(-2.6, Math.min(2.6, mdx + gaze * 2.4));
  const eye = (cx: number) => {
    const r = Math.min(4.2, ry - 0.6);
    return (
      <g key={cx}>
        <ellipse cx={cx} cy="64" rx="6.6" ry={ry} fill="#ffffff" stroke={INK} strokeWidth="1.6" />
        <circle cx={cx + dx} cy={64 + dy} r={r} fill="#4a3426" />
        <circle cx={cx + dx} cy={64 + dy} r={r * 0.5} fill="#120c08" />
        <circle cx={cx + dx - r * 0.35} cy={64 + dy - r * 0.4} r={r * 0.32} fill="#ffffff" />
        <path d={`M${cx - 6.8} ${64 - ry + 1.2} Q${cx} ${64 - ry - 2} ${cx + 6.8} ${64 - ry + 1.2}`} stroke={INK} strokeWidth="2.8" fill="none" strokeLinecap="round" />
      </g>
    );
  };
  return <g className="av-blink">{[eye(47), eye(73)]}</g>;
}

function Brows({ mood, color }: { mood: Mood; color: string }) {
  // [left outer y, left inner y, right inner y, right outer y]
  const y: Record<string, [number, number, number, number]> = {
    happy: [52, 50, 50, 52],
    waving: [52, 50, 50, 52],
    worried: [55, 48, 48, 55],
    asking: [49, 49, 52, 53],
    sad: [54, 49, 49, 54],
    frustrated: [49, 56, 56, 49],
    thinking: [51, 50, 54, 54],
    working: [53, 55, 55, 53],
  };
  const [a, b, c, d] = y[mood] ?? [53, 52, 52, 53];
  return (
    <g stroke={darken(color, 0.8)} strokeWidth="3.6" strokeLinecap="round">
      <path d={`M40 ${a} L54 ${b}`} />
      <path d={`M66 ${c} L80 ${d}`} />
    </g>
  );
}

function Mouth({ mood }: { mood: Mood }) {
  const dark = "#5c1d2b";
  switch (mood) {
    case "happy":
    case "waving":
      return (
        <g>
          <path d="M47 81 Q60 99 73 81 Z" fill={dark} stroke={INK} strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M49 82 Q60 85 71 82 L70 84.5 Q60 87.5 50 84.5 Z" fill="#ffffff" />
          <path d="M54 92 Q60 88 66 92 Q60 95 54 92 Z" fill="#e66a7a" />
        </g>
      );
    case "talking":
      return <ellipse className="av-talk" cx="60" cy="85" rx="6" ry="4.4" fill={dark} stroke={INK} strokeWidth="1.6" />;
    case "thinking":
      return <path d="M58 86 Q64 83 68 86" stroke={INK} strokeWidth="2.4" fill="none" strokeLinecap="round" />;
    case "worried":
      return <path d="M49 88 Q53 83 57 88 Q61 92 65 88 Q68 84 71 87" stroke={INK} strokeWidth="2.4" fill="none" strokeLinecap="round" />;
    case "asking":
      return <ellipse cx="62" cy="86" rx="3.4" ry="3.8" fill={dark} stroke={INK} strokeWidth="1.4" />;
    case "sad":
      return <path d="M51 90 Q60 81 69 90" stroke={INK} strokeWidth="2.6" fill="none" strokeLinecap="round" />;
    case "frustrated":
      return (
        <g>
          <rect x="50" y="83" width="20" height="7" rx="2" fill="#ffffff" stroke={INK} strokeWidth="1.8" />
          <path d="M55 83 L55 90 M60 83 L60 90 M65 83 L65 90" stroke={INK} strokeWidth="1" />
        </g>
      );
    case "working":
      return <path d="M53 86 L67 85" stroke={INK} strokeWidth="2.4" strokeLinecap="round" />;
    default:
      return <path d="M51 84 Q60 90 69 84" stroke={INK} strokeWidth="2.5" fill="none" strokeLinecap="round" />;
  }
}

function Extras({ mood, accent }: { mood: Mood; accent: string }) {
  const parts: ReactNode[] = [];
  if (mood === "happy" || mood === "waving") {
    parts.push(
      <g key="blush" fill="#ff6b81" opacity="0.4">
        <ellipse cx="39" cy="77" rx="5.5" ry="3" />
        <ellipse cx="81" cy="77" rx="5.5" ry="3" />
      </g>,
    );
  }
  if (mood === "happy") {
    parts.push(
      <g key="spark" fill={accent}>
        <path className="av-sparkle" d="M104 28 l2.5 6 6 2.5 -6 2.5 -2.5 6 -2.5 -6 -6 -2.5 6 -2.5 Z" />
        <path className="av-sparkle av-sparkle-2" d="M14 34 l2 4.5 4.5 2 -4.5 2 -2 4.5 -2 -4.5 -4.5 -2 4.5 -2 Z" />
      </g>,
    );
  }
  if (mood === "asking") {
    parts.push(
      <g key="ask" className="av-ask">
        <circle cx="104" cy="22" r="11" fill={accent} stroke={INK} strokeWidth="2" />
        <path d="M100 18 Q100 13 104.5 13 Q109 13 109 17.5 Q109 20.5 105 22 L105 25" stroke={INK} strokeWidth="2.6" fill="none" strokeLinecap="round" />
        <circle cx="105" cy="29.5" r="1.7" fill={INK} />
      </g>,
    );
  }
  if (mood === "worried") parts.push(<path key="sweat" className="av-drip" d="M92 40 Q87 50 92 54 Q97 50 92 40 Z" fill="#7dd3fc" stroke={INK} strokeWidth="1.2" />);
  if (mood === "sad") parts.push(<path key="tear" className="av-drip" d="M76 71 Q72 79 76 81 Q80 79 76 71 Z" fill="#7dd3fc" stroke={INK} strokeWidth="1" />);
  if (mood === "thinking") {
    parts.push(
      <g key="thought" className="av-thought" fill="#ffffff" stroke={INK} strokeWidth="1.4">
        <circle cx="96" cy="34" r="3" />
        <circle cx="103" cy="23" r="4.5" />
        <circle cx="111" cy="10" r="6.5" />
      </g>,
    );
  }
  if (mood === "frustrated") {
    parts.push(
      <path
        key="anger"
        className="av-steam"
        d="M80 22 Q87 29 80 36 M98 22 Q91 29 98 36 M82 20 Q89 27 96 20 M82 38 Q89 31 96 38"
        stroke="#ff3b3b"
        strokeWidth="3.6"
        strokeLinecap="round"
        fill="none"
      />,
    );
  }
  return <>{parts}</>;
}

function Head({ look, mood, gaze }: { look: AvatarLook; mood: Mood; gaze?: number }) {
  const skin = SKIN[look.skin];
  const hooded = look.accessory === "hood" || look.accessory === "helmet";
  return (
    <g transform="translate(60 50) scale(0.86) translate(-60 -62)">
      <HairBack look={look} />
      <circle cx="30" cy="65" r="6.5" fill={skin.base} {...OL} />
      <circle cx="90" cy="65" r="6.5" fill={skin.base} {...OL} />
      <path d="M30 60 Q30 28 60 28 Q90 28 90 60 Q90 84 74 92 Q60 98 46 92 Q30 84 30 60 Z" fill={skin.base} {...OL} strokeWidth="2.4" />
      <path d="M80 40 Q91 54 88 70 Q86 85 73 92 Q85 72 80 40 Z" fill={skin.shade} opacity="0.75" />
      {!hooded && <HairFront look={look} />}
      {hooded && look.hair !== "bald" && look.hair !== "buzz" && <path d="M36 50 Q48 40 60 46 Q72 40 84 50 Q72 46 60 52 Q48 46 36 50 Z" fill={look.hairColor} />}
      <Brows mood={mood} color={look.hairColor} />
      <Eyes mood={mood} gaze={gaze} />
      <path d="M60 69 Q57 76 62 77" stroke={skin.shade} strokeWidth="2.2" fill="none" strokeLinecap="round" />
      <Mouth mood={mood} />
      <Headgear look={look} />
      <Extras mood={mood} accent={look.accent} />
    </g>
  );
}

export function Avatar({
  look,
  mood = "idle",
  size = 120,
  crop,
  className,
  title,
  svgRef,
  gaze,
}: {
  look: AvatarLook;
  mood?: Mood;
  /** -1 (looking left) … 1 (looking right): the eyes follow the cursor on the desktop. */
  gaze?: number;
  /** Width in px. */
  size?: number;
  /** "head": a square portrait for small spots (lists, cards). */
  crop?: "head";
  className?: string;
  title?: string;
  svgRef?: Ref<SVGSVGElement>;
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const k = kit(look);
  const pose = arms(mood);
  const skin = SKIN[look.skin];
  const torso = look.outfit === "robe" ? ROBE : TORSO;
  const head = crop === "head";
  return (
    <svg
      ref={svgRef}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={head ? "16 0 88 88" : "0 0 120 170"}
      width={size}
      height={head ? size : (size * 170) / 120}
      className={cn("av", `av-${mood}`, className)}
      role="img"
      aria-label={title ?? `avatar, ${mood}`}
    >
      <defs>
        <clipPath id={`torso${id}`}>
          <path d={torso} />
        </clipPath>
      </defs>
      {!head && <ellipse cx="60" cy="163" rx="32" ry="4.5" fill="#000000" opacity="0.28" />}
      <g className="av-body">
        <BackGear look={look} />
        <Legs k={k} look={look} />
        <path d={torso} fill={k.torso} {...OL} strokeWidth="2.4" />
        <g clipPath={`url(#torso${id})`}>
          <OutfitDetails look={look} />
          <path d="M66 82 Q90 84 96 102 L100 160 L70 160 Q76 110 66 82 Z" fill="#000000" opacity="0.18" />
          <path d="M28 100 Q30 91 42 88 Q36 112 38 160 L24 160 Z" fill="#ffffff" opacity="0.12" />
        </g>
        <path d="M52 70 L52 90 Q60 95 68 90 L68 70 Z" fill={skin.shade} {...OL} />
        <Collar look={look} />
        {look.back === "pack" && <path d="M41 91 L44 124 M79 91 L76 124" stroke="#27272a" strokeWidth="4" strokeLinecap="round" />}
        <Arm pose={pose.left} k={k} look={look} />
        {mood === "working" && <Holo look={look} />}
        <Arm pose={pose.right} k={k} look={look} />
        <Pauldrons look={look} />
        <Head look={look} mood={mood} gaze={gaze} />
      </g>
    </svg>
  );
}
