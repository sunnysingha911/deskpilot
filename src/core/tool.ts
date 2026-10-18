import { z } from "zod";
import type { Risk } from "./risk.ts";
import type { TaskInfo } from "./task.ts";

export type Platform = NodeJS.Platform;

export interface ToolContext {
  /** Who is calling: "cli", an agent name, a test. Logged. */
  caller: string;
  sessionId: string;
  /** Agents that led to this call, outermost first, ending with the caller (["mac-helper", "coder"]). */
  chain?: string[];
  signal?: AbortSignal;
  /** The task this call belongs to (desktop turn-taking, per-task browser tab). Missing = a one-off call. */
  task?: TaskInfo;
  /** A tool that waits on the user (e.g. ask_user) reports that time here; it's left out of time budgets. */
  addWait?: (ms: number) => void;
}

export interface ToolDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: I;
  output: O;
  /**
   * Static risk, or a classifier over the validated input. Classifiers may inspect live state
   * (e.g. the label of the button about to be pressed). They should only ever *raise* risk
   * above `baseRisk`, never lower it.
   */
  baseRisk: Risk;
  classify?: (input: z.infer<I>, ctx: ToolContext) => Risk | Promise<Risk>;
  /** Drives the real screen/keyboard/mouse: runs one at a time across tasks (see desktop-lock.ts). */
  desktop?: boolean;
  /** OSes where this tool is available. Omitted = all. */
  platforms?: Platform[];
  /** false = never given to agents (still runnable by hand). Default true. */
  agentVisible?: boolean;
  /** Output contains content from screens, web pages, files or processes: data, not instructions. */
  untrustedOutput: boolean;
  /** Return a copy of the input that is safe to store in the log (e.g. hide typed passwords). */
  redactInput?: (input: z.infer<I>) => unknown;
  run: (input: z.infer<I>, ctx: ToolContext) => Promise<z.infer<O>>;
}

/** Identity helper that preserves generic inference. */
export function defineTool<I extends z.ZodType, O extends z.ZodType>(def: ToolDef<I, O>): ToolDef<I, O> {
  return def;
}

/** Errors a tool throws on purpose; message is shown to the caller. */
export class ToolError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/** JSON-schema description of a tool, shaped for LLM tool-use APIs. */
export function toolSpec(def: ToolDef) {
  return {
    name: def.name,
    description: def.description,
    inputSchema: z.toJSONSchema(def.input, { io: "input" }),
    outputSchema: z.toJSONSchema(def.output, { io: "output" }),
    baseRisk: def.baseRisk,
    untrustedOutput: def.untrustedOutput,
  };
}
