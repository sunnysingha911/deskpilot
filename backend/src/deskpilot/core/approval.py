"""Terminal approver: asks y/N on a TTY. Non-interactive runs deny, unless auto-approve is set (only for
hand-run tool calls via --approve; agents never get that flag)."""

import asyncio
import json
import sys

from deskpilot.core.executor import ApprovalDecision, ApprovalRequest, Approver


def cli_approver(*, auto_approve: bool = False) -> Approver:
    async def ask(req: ApprovalRequest) -> ApprovalDecision:
        if auto_approve:
            return ApprovalDecision(approved=True, by="user:cli-flag")
        if not sys.stdin.isatty():
            return ApprovalDecision(approved=False, by="policy:non-interactive")
        why = "IRREVERSIBLE" if req.reason == "irreversible" else "APPROVAL REQUIRED (agent rule)"
        who = f"you → {' → '.join(req.chain)}" if req.chain and len(req.chain) > 1 else req.caller
        prompt = f"\n⚠️  {why}: {who} wants to run {req.tool}\n{json.dumps(req.input, indent=2)}\nApprove? [y/N] "
        answer = await asyncio.to_thread(input, prompt)
        return ApprovalDecision(approved=answer.strip().lower() in ("y", "yes"), by="user:prompt")

    return ask
