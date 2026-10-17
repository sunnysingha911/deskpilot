// The single-agent loop: model → tool calls → executor (validate, classify, approve, run, log) → model.
import { randomUUID } from "node:crypto";
import type { Executor } from "../core/executor.ts";
import type { ActionLogger, RunStatus, RunSummary } from "../core/logger.ts";
import { toolSpec } from "../core/tool.ts";
import type { ModelProvider, ToolResultInput, TurnInput, Usage } from "../llm/types.ts";
import { needsAlwaysAsk, resolveTools, type AgentDefinition } from "./definition.ts";
import { buildSystemPrompt, formatToolResult } from "./prompt.ts";

export type RunEvent =
  | { type: "start"; runId: string; tools: string[] }
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; status: string; risk: string; summary: string }
  | { type: "turn"; step: number; usage: Usage; servedBy: string }
  | { type: "end"; summary: RunSummary };

export interface RunDeps {
  provider: ModelProvider;
  executor: Executor;
  logger: ActionLogger;
  onEvent?: (e: RunEvent) => void;
}

export interface RunResult extends RunSummary {
  runId: string;
}

export async function runAgent(def: AgentDefinition, task: string, deps: RunDeps): Promise<RunResult> {
  const runId = `run-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const emit = deps.onEvent ?? (() => {});
  const tools = resolveTools(def, deps.executor.list());
  const allowed = new Set(tools.map((t) => t.name));

  const session = deps.provider.startSession({
    model: def.model.id,
    system: buildSystemPrompt(def),
    tools: tools.map((t) => {
      const s = toolSpec(t);
      return { name: s.name, description: s.description, inputSchema: s.inputSchema as Record<string, unknown> };
    }),
    maxTokensPerTurn: def.model.maxTokensPerTurn,
    effort: def.model.effort,
  });

  deps.logger.startRun({ id: runId, agent: def.name, provider: deps.provider.id, model: def.model.id, task });
  emit({ type: "start", runId, tools: [...allowed] });

  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const started = Date.now();
  let steps = 0;
  let finalText: string | undefined;
  let status: RunStatus = "budget_exhausted";
  let error: string | undefined;
  let input: TurnInput = { kind: "user", text: task };

  try {
    while (true) {
      if (steps >= def.budget.maxSteps) {
        error = `step budget (${def.budget.maxSteps}) exhausted`;
        break;
      }
      if (usage.outputTokens >= def.budget.maxOutputTokens) {
        error = `output token budget (${def.budget.maxOutputTokens}) exhausted`;
        break;
      }
      if ((Date.now() - started) / 1000 >= def.budget.maxSeconds) {
        error = `time budget (${def.budget.maxSeconds}s) exhausted`;
        break;
      }

      const turn = await session.next(input);
      steps++;
      usage.inputTokens += turn.usage.inputTokens;
      usage.outputTokens += turn.usage.outputTokens;
      usage.cacheReadTokens += turn.usage.cacheReadTokens;
      usage.cacheWriteTokens += turn.usage.cacheWriteTokens;
      if (turn.thinking) emit({ type: "thinking", text: turn.thinking });
      if (turn.text) emit({ type: "text", text: turn.text });
      emit({ type: "turn", step: steps, usage: turn.usage, servedBy: turn.servedBy });

      if (turn.stop === "refusal") {
        status = "refused";
        error = `model declined (category: ${turn.refusal?.category ?? "unknown"})`;
        finalText = turn.text || undefined;
        break;
      }
      if (turn.stop === "max_tokens") {
        // A turn cut off mid-way may hold a truncated tool call; don't run it.
        status = "max_tokens";
        error = `turn hit maxTokensPerTurn (${def.model.maxTokensPerTurn})`;
        finalText = turn.text || undefined;
        break;
      }
      if (turn.stop === "pause") {
        input = { kind: "continue" };
        continue;
      }
      if (turn.toolCalls.length === 0) {
        status = "completed";
        finalText = turn.text;
        break;
      }

      // Run tool calls one at a time: desktop actions must not interleave.
      const results: ToolResultInput[] = [];
      for (const call of turn.toolCalls) {
        emit({ type: "tool_call", name: call.name, input: call.input });
        if (!allowed.has(call.name)) {
          deps.logger.log({
            sessionId: runId,
            caller: def.name,
            tool: call.name,
            risk: "irreversible",
            status: "error",
            input: call.input,
            error: "tool_not_allowed",
            durationMs: 0,
          });
          results.push({ id: call.id, content: `ERROR tool_not_allowed: '${call.name}' is not available to this agent.`, isError: true });
          emit({ type: "tool_result", name: call.name, status: "error", risk: "-", summary: "not allowed" });
          continue;
        }
        const r = await deps.executor.call(
          call.name,
          call.input,
          { caller: def.name, sessionId: runId },
          { forceApproval: needsAlwaysAsk(def, call.name) },
        );
        const formatted = formatToolResult(r);
        results.push({ id: call.id, ...formatted });
        emit({
          type: "tool_result",
          name: call.name,
          status: r.status,
          risk: r.risk,
          summary: r.ok ? `${r.durationMs}ms` : (r.error?.message ?? r.status),
        });
      }
      input = { kind: "tool_results", results };
    }
  } catch (err) {
    status = "error";
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }

  const summary: RunSummary = { status, steps, usage, finalText, error };
  deps.logger.finishRun(runId, { ...summary, transcript: session.transcript() });
  emit({ type: "end", summary });
  return { runId, ...summary };
}
