// Talking with a running agent. The user can send messages while it works (delivered after its
// current step), and the agent can ask the user a question with ask_user and wait for the answer.
// Implemented by the GUI run manager and the CLI; a run without one simply has neither.
//
// What the user writes is the user's own instruction. What the agent asks is model output and may be
// shaped by untrusted content, so the UI labels it as AI-written and never renders links in it.
import { z } from "zod";
import { defineTool, type ToolDef } from "../core/tool.ts";

export const ASK_USER_TOOL = "ask_user";

export interface Question {
  /** Run that asked (a delegated run's id when a called agent asks). */
  runId: string;
  agent: string;
  question: string;
  choices?: string[] | undefined;
}

export interface Interaction {
  /** Messages the user sent to this run since the last call (empty for runs that don't take messages). */
  takeMessages(runId: string): string[];
  /** Ask the user. Resolves with their answer, or null if nobody answered (timeout, stop). */
  ask(q: Question, signal?: AbortSignal): Promise<{ answer: string | null; by: string }>;
}

/** How user messages reach the model: plainly from the user, after whatever it was doing. */
export function userMessagesNote(messages: string[]): string {
  const body = messages.length === 1 ? messages[0]! : messages.map((m, i) => `${i + 1}. ${m}`).join("\n");
  return `Message from the user, sent while you were working (it is from the user, not from a tool):\n${body}`;
}

export function makeAskUserTool(interaction: Interaction, agent: string): ToolDef {
  return defineTool({
    name: ASK_USER_TOOL,
    description:
      "Ask the user a question and wait for the answer. Use it when the task is ambiguous or you need a decision only the user can make; don't use it for things you can find out yourself. Don't use it to ask permission for an action: risky actions already pause for the user's approval automatically, so just call the tool. Offer choices when there are a few clear options. Never ask for passwords, API keys, card numbers or other secrets.",
    input: z
      .object({
        question: z.string().min(1).max(600).describe("Short, specific question"),
        choices: z.array(z.string().min(1).max(80)).min(2).max(6).optional().describe("Suggested answers shown as buttons; the user can still type anything"),
      })
      .strict(),
    output: z.object({ answered: z.boolean(), answer: z.string().nullable(), note: z.string().optional() }),
    baseRisk: "read_only",
    // The answer is written by the user.
    untrustedOutput: false,
    run: async (i, ctx) => {
      const asked = performance.now();
      try {
        const r = await interaction.ask({ runId: ctx.sessionId, agent, question: i.question, choices: i.choices }, ctx.signal);
        return r.answer === null
          ? { answered: false, answer: null, note: `no answer (${r.by}); carry on with your best judgement and say what you assumed` }
          : { answered: true, answer: r.answer };
      } finally {
        ctx.addWait?.(performance.now() - asked);
      }
    },
  }) as ToolDef;
}
