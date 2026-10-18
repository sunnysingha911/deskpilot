import { createInterface } from "node:readline/promises";
import type { Approver } from "./executor.ts";

/**
 * Terminal approver: asks y/N on a TTY. Non-interactive runs deny, unless autoApprove is set
 * (only for hand-run tool calls via --approve; agents never get that flag).
 */
export function cliApprover(opts: { autoApprove?: boolean } = {}): Approver {
  return async (req) => {
    if (opts.autoApprove) return { approved: true, by: "user:cli-flag" };
    if (!process.stdin.isTTY) return { approved: false, by: "policy:non-interactive" };
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const why = req.reason === "irreversible" ? "IRREVERSIBLE" : "APPROVAL REQUIRED (agent rule)";
      const answer = await rl.question(
        `\n⚠️  ${why}: ${req.chain && req.chain.length > 1 ? `you → ${req.chain.join(" → ")}` : req.caller} wants to run ${req.tool}\n${JSON.stringify(req.input, null, 2)}\nApprove? [y/N] `,
      );
      return { approved: /^y(es)?$/i.test(answer.trim()), by: "user:prompt" };
    } finally {
      rl.close();
    }
  };
}
