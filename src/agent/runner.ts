// The single-agent loop: model → tool calls → executor (validate, classify, approve, run, log) → model.
import { randomUUID } from "node:crypto";
import type { AttachmentSet } from "../core/attachments.ts";
import type { Executor } from "../core/executor.ts";
import type { ActionLogger, RunStatus, RunSummary } from "../core/logger.ts";
import { defineTool, ToolError, toolSpec, type ToolDef } from "../core/tool.ts";
import type { InlineFile, ModelProvider, ToolResultInput, TurnInput, Usage } from "../llm/types.ts";
import { attachmentsNote, FILE_READ_TOOL, makeFileReadTool, pickInlineFiles } from "../tools/file.ts";
import {
  DELEGATE_TOOL,
  DelegateInput,
  delegateDescription,
  DelegateOutput,
  delegatedTaskMessage,
  delegationTargets,
  type Delegation,
  type ParentLink,
} from "./delegate.ts";
import { needsAlwaysAsk, resolveTools, type AgentDefinition } from "./definition.ts";
import { DEFAULT_PRUNE, type PrunePolicy } from "../llm/prune.ts";
import { makeResultMoreTool, RESULT_MORE_TOOL } from "../tools/result.ts";
import { buildSystemPrompt, formatToolResult, SpillStore, type FormatStats } from "./prompt.ts";

export type RunEvent =
  | { type: "start"; runId: string; tools: string[]; attachments?: string[] | undefined }
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; status: string; risk: string; summary: string; logId?: number }
  | { type: "turn"; step: number; usage: Usage; servedBy: string }
  | { type: "plan"; steps: Array<{ task: string; agent?: string; status: string; note?: string }> }
  | { type: "delegate_start"; runId: string; agent: string; task: string; depth: number }
  | { type: "delegate_end"; runId: string; agent: string; status: string; steps: number; error?: string | undefined }
  /** An event of a delegated (nested) run, forwarded into the parent's timeline. */
  | { type: "sub"; runId: string; agent: string; depth: number; event: RunEvent }
  /** Context kept out of the model's input in this run (estimates; chars ≈ 4 per token). */
  | { type: "savings"; compactTokens: number; spilledTokens: number; prunedTokens: number }
  | { type: "end"; summary: RunSummary };

export interface RunDeps {
  provider: ModelProvider;
  executor: Executor;
  logger: ActionLogger;
  /** eventId is the persisted run_events row id (for resumable streams). */
  onEvent?: (e: RunEvent, eventId: number) => void;
  /** Abort between steps (pending approvals should be denied by the caller). */
  signal?: AbortSignal;
  /** Use this run id instead of generating one (lets a caller subscribe before the run starts). */
  runId?: string;
  /** Lets this agent call other agents (agent.delegate). Without it, no delegation. */
  delegation?: Delegation | undefined;
  /** The run that started this one. */
  parent?: ParentLink | undefined;
  /**
   * Files attached to the task. The run gets file.read over them; with showToModel, images (and PDFs
   * where the provider supports it) are also sent to the model with the task. Delegated runs share
   * the set but read it with file.read only.
   */
  attachments?: { set: AttachmentSet; showToModel: boolean } | undefined;
  /** Stale-observation pruning (default DEFAULT_PRUNE); false turns it off, e.g. to compare token use. */
  prune?: PrunePolicy | false | undefined;
}

export interface RunResult extends RunSummary {
  runId: string;
  /** Output tokens of this run plus every run it delegated to. */
  totalOutputTokens: number;
  /** Actions blocked (not approved) in this run and every run it delegated to. */
  blockedActions: number;
}

export function newRunId(): string {
  return `run-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
}

export async function runAgent(def: AgentDefinition, task: string, deps: RunDeps): Promise<RunResult> {
  const runId = deps.runId ?? newRunId();
  // Every event is persisted, so a run's workflow can be replayed from history.
  const emit = (e: RunEvent) => {
    const id = deps.logger.logRunEvent(runId, e);
    deps.onEvent?.(e, id);
  };
  const chain = deps.delegation?.chain ?? [];
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  // Output tokens spent by agents this run called; they count against this run's budget too.
  let delegatedOutputTokens = 0;
  // Once anything in this run (or a run it called) was blocked, every further hand-off needs approval,
  // so a declined action can't be re-routed to another agent.
  let blockedActions = 0;
  const started = Date.now();

  const tools = resolveTools(def, deps.executor.list()).filter((t) => t.name !== DELEGATE_TOOL && t.name !== FILE_READ_TOOL && t.name !== RESULT_MORE_TOOL);
  const runTools: ToolDef[] = [];
  const att = deps.attachments?.set.files.length ? deps.attachments : undefined;
  // Images/PDFs the model can view go along with the task; everything stays readable with file.read.
  let inline: InlineFile[] = [];
  if (att?.showToModel && deps.provider.fileInputs) {
    try {
      inline = pickInlineFiles(att.set, await deps.provider.fileInputs(def.model.id));
    } catch {
      inline = [];
    }
  }
  if (att) runTools.push(makeFileReadTool(att.set, inline.map((f) => f.name)));
  if (deps.delegation) {
    const delegateTool = makeDelegateTool(def, deps.delegation, {
      parentRunId: runId,
      deps,
      emit: (e) => emit(e),
      remaining: () => ({
        outputTokens: def.budget.maxOutputTokens - usage.outputTokens - delegatedOutputTokens,
        seconds: Math.floor(def.budget.maxSeconds - (Date.now() - started) / 1000),
      }),
      spent: (outputTokens, blocked) => {
        delegatedOutputTokens += outputTokens;
        blockedActions += blocked;
      },
    });
    if (delegateTool) runTools.push(delegateTool);
  }
  // Very long results are shortened, with the rest readable through result.more (only offered
  // when some tool can return content that long).
  const spill = new SpillStore();
  const stats: FormatStats = { compactChars: 0, spilledChars: 0 };
  let prunedTokens = 0;
  if ([...tools, ...runTools].some((t) => t.untrustedOutput)) runTools.push(makeResultMoreTool(spill));
  tools.push(...runTools);
  const executor = runTools.length ? deps.executor.withTools(runTools) : deps.executor;
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
    prune: deps.prune === false ? undefined : (deps.prune ?? DEFAULT_PRUNE),
    cacheKey: def.name,
  });

  const firstText = att
    ? `${task}\n\n${attachmentsNote(att.set, { shownToModel: inline.map((f) => f.name), canDelegate: runTools.some((t) => t.name === DELEGATE_TOOL) })}`
    : task;

  deps.logger.startRun({
    id: runId,
    agent: def.name,
    provider: deps.provider.id,
    model: def.model.id,
    task,
    parentRunId: deps.parent?.runId,
    relation: deps.parent?.relation,
    attachments: att?.set.id,
  });
  emit({ type: "start", runId, tools: [...allowed], ...(att && { attachments: att.set.files.map((f) => f.name) }) });

  let steps = 0;
  let finalText: string | undefined;
  let status: RunStatus = "budget_exhausted";
  let error: string | undefined;
  let input: TurnInput = { kind: "user", text: firstText, ...(inline.length && { files: inline }) };

  try {
    while (true) {
      if (deps.signal?.aborted) {
        status = "stopped";
        error = "stopped by user";
        break;
      }
      if (steps >= def.budget.maxSteps) {
        error = `step budget (${def.budget.maxSteps}) exhausted`;
        break;
      }
      if (usage.outputTokens + delegatedOutputTokens >= def.budget.maxOutputTokens) {
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
      prunedTokens += turn.prunedTokens ?? 0;
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
        const r = await executor.call(
          call.name,
          call.input,
          { caller: def.name, sessionId: runId, chain: [...chain, def.name], ...(deps.signal && { signal: deps.signal }) },
          {
            forceApproval: needsAlwaysAsk(def, call.name) || (call.name === DELEGATE_TOOL && blockedActions > 0),
            askAbove: def.approval.askAbove,
          },
        );
        if (r.status === "blocked") blockedActions++;
        if (call.name === "plan.update" && r.ok) emit({ type: "plan", steps: (r.output as { steps: Extract<RunEvent, { type: "plan" }>["steps"] }).steps });
        const formatted = formatToolResult(r, { spill, stats });
        results.push({ id: call.id, ...formatted });
        emit({
          type: "tool_result",
          name: call.name,
          status: r.status,
          risk: r.risk,
          summary: r.ok ? `${r.durationMs}ms` : (r.error?.message ?? r.status),
          logId: r.logId,
        });
      }
      input = { kind: "tool_results", results };
    }
  } catch (err) {
    status = "error";
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }

  const savings = { compactTokens: Math.round(stats.compactChars / 4), spilledTokens: Math.round(stats.spilledChars / 4), prunedTokens };
  if (savings.compactTokens || savings.spilledTokens || savings.prunedTokens) emit({ type: "savings", ...savings });
  const summary: RunSummary = { status, steps, usage, finalText, error };
  deps.logger.finishRun(runId, { ...summary, transcript: session.transcript() });
  emit({ type: "end", summary });
  return { runId, ...summary, totalOutputTokens: usage.outputTokens + delegatedOutputTokens, blockedActions };
}

const MIN_DELEGATE_TOKENS = 1000;
const MIN_DELEGATE_SECONDS = 10;

/** Build this run's agent.delegate tool, or null if the agent may not call anyone from here. */
function makeDelegateTool(
  def: AgentDefinition,
  delegation: Delegation,
  run: {
    parentRunId: string;
    deps: RunDeps;
    emit: (e: RunEvent) => void;
    remaining: () => { outputTokens: number; seconds: number };
    spent: (outputTokens: number, blockedActions: number) => void;
  },
): ToolDef | null {
  const chain = delegation.chain ?? [];
  const targets: AgentDefinition[] = [];
  for (const name of delegationTargets(def, delegation)) {
    try {
      targets.push(delegation.loadAgent(name));
    } catch {
      /* missing or invalid agent file: not offered */
    }
  }
  if (!targets.length) return null;
  const names = targets.map((t) => t.name) as [string, ...string[]];

  return defineTool({
    name: DELEGATE_TOOL,
    description: delegateDescription(targets),
    input: DelegateInput(names),
    output: DelegateOutput,
    // The call itself changes nothing; every action the called agent takes is classified and
    // approved on its own. Add agent.delegate to approval.alwaysAsk to approve each hand-off.
    baseRisk: "reversible",
    untrustedOutput: true,
    run: async (input) => {
      const target = targets.find((t) => t.name === input.agent)!;
      const left = run.remaining();
      if (left.outputTokens < MIN_DELEGATE_TOKENS || left.seconds < MIN_DELEGATE_SECONDS) {
        throw new ToolError("budget", `not enough budget left to delegate (${left.outputTokens} output tokens, ${left.seconds}s)`);
      }
      // The called agent can never outspend what the caller has left.
      const bounded: AgentDefinition = {
        ...target,
        budget: {
          ...target.budget,
          maxOutputTokens: Math.min(target.budget.maxOutputTokens, left.outputTokens),
          maxSeconds: Math.min(target.budget.maxSeconds, left.seconds),
        },
      };
      const childChain = [...chain, def.name];
      const childRunId = newRunId();
      const depth = childChain.length;
      run.emit({ type: "delegate_start", runId: childRunId, agent: target.name, task: input.task, depth });
      const result = await runAgent(bounded, delegatedTaskMessage(childChain, input.task), {
        provider: delegation.providerFor(target),
        executor: run.deps.executor,
        logger: run.deps.logger,
        signal: run.deps.signal,
        runId: childRunId,
        parent: { runId: run.parentRunId, relation: "delegate" },
        delegation: { loadAgent: delegation.loadAgent, providerFor: delegation.providerFor, listAgents: delegation.listAgents, chain: childChain },
        attachments: run.deps.attachments && { set: run.deps.attachments.set, showToModel: false },
        prune: run.deps.prune,
        // Nested runs' events already arrive wrapped; pass those through unchanged.
        onEvent: (e) => run.emit(e.type === "sub" ? e : { type: "sub", runId: childRunId, agent: target.name, depth, event: e }),
      });
      run.spent(result.totalOutputTokens, result.blockedActions);
      run.emit({ type: "delegate_end", runId: childRunId, agent: target.name, status: result.status, steps: result.steps, error: result.error });
      return {
        agent: target.name,
        runId: childRunId,
        status: result.status,
        steps: result.steps,
        answer: result.finalText ?? null,
        error: result.error ?? null,
        blockedActions: result.blockedActions,
      };
    },
  }) as ToolDef;
}
