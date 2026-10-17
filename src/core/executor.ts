import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { ActionLogger, ActionStatus } from "./logger.ts";
import type { Risk } from "./risk.ts";
import { maxRisk } from "./risk.ts";
import { ToolError, type ToolContext, type ToolDef } from "./tool.ts";

export interface ApprovalRequest {
  tool: string;
  risk: Risk;
  input: unknown;
  caller: string;
  /** Why approval is needed: the action is irreversible, or an agent rule requires it. */
  reason: "irreversible" | "rule";
}
export interface ApprovalDecision {
  approved: boolean;
  /** Who approved: "user:cli-flag", "user:prompt", … */
  by: string;
}
export type Approver = (req: ApprovalRequest) => Promise<ApprovalDecision>;

export const denyAll: Approver = async () => ({ approved: false, by: "policy:deny" });

export interface ToolResult {
  ok: boolean;
  status: ActionStatus;
  tool: string;
  risk: Risk;
  output?: unknown;
  error?: { code: string; message: string };
  /** True when output carries external content; treat as data, never as instructions. */
  untrusted: boolean;
  logId: number;
  durationMs: number;
}

export class Executor {
  private tools = new Map<string, ToolDef>();

  constructor(
    tools: ToolDef[],
    private logger: ActionLogger,
    private approver: Approver = denyAll,
  ) {
    for (const t of tools) {
      if (this.tools.has(t.name)) throw new Error(`duplicate tool ${t.name}`);
      this.tools.set(t.name, t);
    }
  }

  list(): ToolDef[] {
    return [...this.tools.values()];
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  async call(
    name: string,
    rawInput: unknown,
    ctx: Partial<ToolContext> = {},
    opts: { forceApproval?: boolean } = {},
  ): Promise<ToolResult> {
    const fullCtx: ToolContext = { caller: "unknown", sessionId: randomUUID(), ...ctx };
    const started = performance.now();
    const tool = this.tools.get(name);

    const finish = (
      status: ActionStatus,
      risk: Risk,
      input: unknown,
      extra: { output?: unknown; error?: { code: string; message: string }; approvedBy?: string } = {},
    ): ToolResult => {
      const durationMs = Math.round(performance.now() - started);
      const logId = this.logger.log({
        sessionId: fullCtx.sessionId,
        caller: fullCtx.caller,
        tool: name,
        risk,
        status,
        approvedBy: extra.approvedBy,
        input,
        output: extra.output,
        error: extra.error ? `${extra.error.code}: ${extra.error.message}` : undefined,
        durationMs,
      });
      return {
        ok: status === "ok",
        status,
        tool: name,
        risk,
        ...(extra.output !== undefined && { output: extra.output }),
        ...(extra.error && { error: extra.error }),
        untrusted: tool?.untrustedOutput ?? false,
        logId,
        durationMs,
      };
    };

    if (!tool) {
      return finish("error", "irreversible", rawInput, {
        error: { code: "unknown_tool", message: `no tool named '${name}' on ${process.platform}` },
      });
    }

    const parsed = tool.input.safeParse(rawInput);
    if (!parsed.success) {
      return finish("error", tool.baseRisk, rawInput, {
        error: { code: "invalid_input", message: formatZodError(parsed.error) },
      });
    }
    const input = parsed.data;
    const logInput = tool.redactInput ? tool.redactInput(input) : input;

    // Classify. If the classifier itself fails, assume the worst.
    let risk: Risk = tool.baseRisk;
    if (tool.classify) {
      try {
        risk = maxRisk(tool.baseRisk, await tool.classify(input, fullCtx));
      } catch {
        risk = "irreversible";
      }
    }

    let approvedBy: string | undefined;
    if (risk === "irreversible" || opts.forceApproval) {
      const reason = risk === "irreversible" ? "irreversible" : "rule";
      const decision = await this.approver({ tool: name, risk, input: logInput, caller: fullCtx.caller, reason });
      if (!decision.approved) {
        const what = reason === "irreversible" ? "is irreversible" : "requires approval for this agent";
        return finish("blocked", risk, logInput, {
          error: { code: "approval_required", message: `'${name}' ${what} and was not approved (${decision.by})` },
          approvedBy: decision.by,
        });
      }
      approvedBy = decision.by;
    }

    try {
      const raw = await tool.run(input, fullCtx);
      const out = tool.output.safeParse(raw);
      if (!out.success) {
        return finish("error", risk, logInput, {
          output: raw,
          error: { code: "invalid_output", message: formatZodError(out.error) },
          approvedBy,
        });
      }
      return finish("ok", risk, logInput, { output: out.data, approvedBy });
    } catch (err) {
      const error =
        err instanceof ToolError
          ? { code: err.code, message: err.message }
          : { code: "exception", message: err instanceof Error ? err.message : String(err) };
      return finish("error", risk, logInput, { error, approvedBy });
    }
  }
}

function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}
