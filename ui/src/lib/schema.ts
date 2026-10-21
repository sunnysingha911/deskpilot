// Agent definition schema (zod), the web app's copy of the backend's (backend/src/deskpilot/agent/schema.py): validates
// agent files in the editor and draws default avatar looks (defaultLook matches the backend's bit for bit).
import { z } from "zod";

const ToolPattern = z.string().regex(/^[a-z_]+(\.[a-z_]+|\.\*)?$|^\*$/, 'tool name or glob like "ui.*"');
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

// ── Avatar: how the agent looks on the desktop overlay and in the control panel ──
export const SKIN_TONES = ["porcelain", "light", "tan", "olive", "brown", "deep"] as const;
export const HAIR_STYLES = ["spiky", "swoop", "short", "buzz", "curly", "long", "bun", "ponytail", "afro", "mohawk", "bald"] as const;
/** Headgear and face gear. */
export const ACCESSORIES = ["none", "visor", "goggles", "helmet", "hood", "crown", "headset", "glasses", "sunglasses", "cap", "beanie", "earrings"] as const;
/** Body outfit; the main colour is `shirt`. */
export const OUTFITS = ["hoodie", "tactical", "armor", "jacket", "robe", "suit"] as const;
/** Gear worn on the back. */
export const BACK_ITEMS = ["none", "pack", "jetpack", "wings", "cape", "shield"] as const;
const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a colour like #3366cc");

export const AvatarLook = z
  .object({
    skin: z.enum(SKIN_TONES),
    hair: z.enum(HAIR_STYLES),
    hairColor: HexColor,
    shirt: HexColor,
    accessory: z.enum(ACCESSORIES).default("none"),
    outfit: z.enum(OUTFITS).default("hoodie"),
    back: z.enum(BACK_ITEMS).default("none"),
    /** Glow colour: trims, visor, and the magic dust when the agent appears or vanishes. */
    accent: HexColor.default("#22d3ee"),
  })
  .strict();
export type AvatarLook = z.infer<typeof AvatarLook>;

const HAIR_COLORS = ["#2b1d14", "#4a2f1d", "#7a4b2a", "#b9773b", "#e3c27a", "#1c1c1f", "#8c8c8c", "#a8322d"];
const SHIRT_COLORS = ["#3b6fd8", "#e2574c", "#2f9e72", "#8a5cd6", "#e39b2d", "#2a9bb5", "#d44f8f", "#4b5563"];
const ACCENT_COLORS = ["#22d3ee", "#facc15", "#f43f5e", "#a3e635", "#c084fc", "#fb923c", "#34d399", "#f472b6"];

/** A stable look derived from the agent's name, for agents without an avatar block. */
export function defaultLook(name: string): AvatarLook {
  // An independent hash per feature, so similar names still get clearly different people.
  const hash = (s: string) => {
    let h = 2166136261;
    for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    return (h ^ (h >>> 15)) >>> 0;
  };
  const pick = <T,>(list: readonly T[], feature: string) => list[hash(`${feature}:${name}`) % list.length]!;
  return {
    skin: pick(SKIN_TONES, "skin"),
    hair: pick(HAIR_STYLES.filter((s) => s !== "bald" && s !== "mohawk"), "hair"),
    hairColor: pick(HAIR_COLORS, "hairColor"),
    shirt: pick(SHIRT_COLORS, "shirt"),
    accessory: pick(["none", "none", "visor", "goggles", "headset", "glasses", "cap", "crown"] as const, "accessory"),
    outfit: pick(OUTFITS, "outfit"),
    back: pick(BACK_ITEMS, "back"),
    accent: pick(ACCENT_COLORS, "accent"),
  };
}

export const AgentDefinition = z
  .object({
    name: z.string().regex(AGENT_NAME_RE),
    description: z.string(),
    system: z.string().min(1).describe("Role-specific instructions; the safety preamble is added automatically"),
    /** Tool names or globs. May be empty for an agent that only hands work to others. */
    tools: z.array(ToolPattern).default([]),
    model: z
      .object({
        provider: z.enum(["anthropic", "openai-compatible", "ollama"]),
        /** Named connection from the provider registry (e.g. "openai", "xai"); fills baseUrl/apiKeyEnv. */
        connection: z.string().regex(/^[a-z0-9-]+$/).optional(),
        id: z.string().min(1),
        baseUrl: z.string().url().optional(),
        apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
        effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
        maxTokensPerTurn: z.number().int().min(1024).max(128_000).default(16_000),
      })
      .strict(),
    budget: z
      .object({
        maxSteps: z.number().int().min(1).max(500).default(25),
        maxOutputTokens: z.number().int().min(1000).default(100_000),
        maxSeconds: z.number().int().min(10).default(600),
      })
      .strict()
      .prefault({}),
    /** How the agent looks on the desktop overlay; omitted = derived from the name. */
    avatar: AvatarLook.optional(),
    /** Other agents this one may hand sub-tasks to (gives it the agent.delegate tool). "*" = any agent. */
    canDelegateTo: z.array(z.union([z.literal("*"), z.string().regex(AGENT_NAME_RE)])).default([]),
    approval: z
      .object({
        /** Tools (or globs) that need approval on every call, whatever their risk. Irreversible always does. */
        alwaysAsk: z.array(ToolPattern).default([]),
        /** Ask for any action riskier than this, whatever the tool ("read_only" = only reads run freely). */
        askAbove: z.enum(["read_only", "reversible"]).optional(),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .refine((d) => d.tools.length > 0 || d.canDelegateTo.length > 0, {
    message: "give the agent at least one tool, or agents it can hand work to",
    path: ["tools"],
  });
export type AgentDefinition = z.infer<typeof AgentDefinition>;

export function matchesPattern(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return toolName.startsWith(pattern.slice(0, -1));
  return pattern === toolName;
}

/** Agents named as @name in a task, in order, limited to known names and excluding `self`. */
export function parseMentions(task: string, known: string[], self?: string): string[] {
  const out: string[] = [];
  for (const m of task.matchAll(/(?<![\w@.-])@([a-z0-9][a-z0-9-]*)/g)) {
    const name = m[1]!.replace(/-+$/, "");
    if (name !== self && known.includes(name) && !out.includes(name)) out.push(name);
  }
  return out;
}
