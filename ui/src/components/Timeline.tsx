// Run workflow timeline, shared by the live view and run history. Every value from a run is
// rendered as React text (escaped); run output is untrusted and must never become HTML.
import { useQuery } from "@tanstack/react-query";
import { ArrowRightLeft, Bot, Brain, Check, Circle, CircleCheck, CircleHelp, CircleX, ListChecks, LoaderCircle, MinusCircle, Send, ShieldAlert, User, Users, Wrench } from "lucide-react";
import { Link } from "react-router";
import { useState, type ReactNode } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, get } from "@/lib/api";
import { fmtNum, pretty } from "@/lib/format";
import type { RunDetail, RunEvent } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { RunStream } from "@/hooks/useRunEvents";
import { Orb } from "@/components/Orb";
import { useArsenal } from "@/components/Layout";

type Ev = RunStream["events"][number];

type Item =
  | { kind: "event"; ev: Ev }
  | { kind: "tool"; call: Ev; result?: Ev }
  | { kind: "approval"; req: Ev; resolved?: Ev }
  | { kind: "question"; q: Ev; answered?: Ev }
  | { kind: "delegate"; start: Ev; end?: Ev; items: Item[]; plan?: Ev };

/** The newest plan.update checklist among a run's own events. */
const latestPlan = (events: Ev[]) => events.findLast((e) => e.type === "plan");

/**
 * Events of runs this run delegated to arrive wrapped ({type:"sub", runId, event}) in one flat stream,
 * whatever their depth. Unwrap them per run, then nest each run's items under its delegate_start.
 */
function buildItems(events: Ev[]): Item[] {
  const byRun = new Map<string, Ev[]>();
  const top: Ev[] = [];
  for (const ev of events) {
    if (ev.type === "sub" && ev.event) {
      const list = byRun.get(ev.runId) ?? [];
      list.push({ ...ev.event, _runId: ev.runId, _key: ev._key });
      byRun.set(ev.runId, list);
    } else top.push(ev);
  }
  return groupItems(top, byRun);
}

/** Pair tool_call with its tool_result and approval_request with its resolution; nest delegated runs. */
function groupItems(events: Ev[], byRun: Map<string, Ev[]>): Item[] {
  const items: Item[] = [];
  const delegates = new Map<string, Extract<Item, { kind: "delegate" }>>();
  const openTools: Array<Extract<Item, { kind: "tool" }>> = [];
  const approvals = new Map<string, Extract<Item, { kind: "approval" }>>();
  const questions = new Map<string, Extract<Item, { kind: "question" }>>();
  for (const ev of events) {
    if (ev.type === "question") {
      const it = { kind: "question" as const, q: ev };
      questions.set(`${ev._runId}:${ev.id}`, it);
      items.push(it);
    } else if (ev.type === "question_answered") {
      const it = questions.get(`${ev._runId}:${ev.id}`);
      if (it) it.answered = ev;
    } else if (ev.type === "tool_call") {
      const it = { kind: "tool" as const, call: ev };
      openTools.push(it);
      // ask_user shows as its question card instead.
      if (ev.name !== "ask_user") items.push(it);
    } else if (ev.type === "tool_result") {
      const it = openTools.shift();
      if (it) it.result = ev;
    } else if (ev.type === "approval_request") {
      const it = { kind: "approval" as const, req: ev };
      approvals.set(`${ev._runId}:${ev.id}`, it);
      items.push(it);
    } else if (ev.type === "approval_resolved") {
      const it = approvals.get(`${ev._runId}:${ev.id}`);
      if (it) it.resolved = ev;
    } else if (ev.type === "delegate_start") {
      const own = byRun.get(ev.runId) ?? [];
      const it = { kind: "delegate" as const, start: ev, items: groupItems(own, byRun), plan: latestPlan(own) };
      delegates.set(ev.runId, it);
      items.push(it);
    } else if (ev.type === "delegate_end") {
      const it = delegates.get(ev.runId);
      if (it) it.end = ev;
    } else if (ev.type !== "closed" && ev.type !== "plan") {
      items.push({ kind: "event", ev });
    }
  }
  return items;
}

function Row({ tone = "neutral", icon, children, className }: { tone?: "neutral" | "ok" | "warn" | "bad" | "info" | "muted"; icon?: ReactNode; children: ReactNode; className?: string }) {
  const border = { neutral: "border-l-border", ok: "border-l-ok", warn: "border-l-warn", bad: "border-l-bad", info: "border-l-primary", muted: "border-l-muted-foreground/40" }[tone];
  return (
    <div className={cn("flex gap-3 rounded-lg border border-l-[3px] bg-card px-3.5 py-2.5", border, className)}>
      {icon && <div className="mt-0.5 text-muted-foreground [&_svg]:size-4">{icon}</div>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Pre({ children }: { children: string }) {
  return <pre className="mt-2 max-h-80 overflow-auto rounded-md border bg-muted p-2.5 font-mono text-xs whitespace-pre-wrap break-words">{children}</pre>;
}

function Expand({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button className="text-xs text-muted-foreground hover:text-foreground cursor-pointer" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} {label}
      </button>
      {open && children}
    </div>
  );
}

function ToolOutput({ runId, logId }: { runId: string; logId: number }) {
  const q = useQuery({ queryKey: ["run", runId], queryFn: () => get<RunDetail>(`/api/runs/${runId}`) });
  if (q.isLoading) return <Pre>loading…</Pre>;
  const a = q.data?.actions.find((x) => x.id === logId);
  return <Pre>{a ? pretty(a.output_json ?? a.error ?? "(no output)") : "(not found)"}</Pre>;
}

function ToolItem({ call, result }: { call: Ev; result?: Ev }) {
  const status: string = result?.status ?? "running";
  const tone = !result ? "warn" : status === "ok" ? "ok" : "bad";
  return (
    <Row tone={tone} icon={<Wrench />}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px] font-semibold">{call.name}</span>
        <StatusBadge value={status} />
        {result && result.risk !== "-" && <StatusBadge value={result.risk} />}
        {result && <span className="text-xs text-muted-foreground">{result.summary}</span>}
      </div>
      <Expand label="input">
        <Pre>{pretty(call.input)}</Pre>
      </Expand>
      {result?.logId ? (
        <Expand label="output">
          <ToolOutput runId={call._runId} logId={result.logId} />
        </Expand>
      ) : null}
    </Row>
  );
}

function ArsenalDecisionRow({ ev }: { ev: RunEvent }) {
  const arsenal = useArsenal();
  const [open, setOpen] = useState(false);
  return (
    <Row tone="info" icon={<Orb color={arsenal.data?.settings.color} size={18} className="-my-1" />}>
      <div className="text-sm">
        <b>A.R.S.E.N.A.L</b> sent <b>{ev.agent}</b>
        {ev.connection ? ` on ${ev.connection} · ${ev.model}` : ""} · <span className="capitalize">{ev.mode}</span> · {ev.priority} priority{" "}
        <span className="text-xs text-muted-foreground">({Math.round(ev.confidence * 100)}% sure{ev.notes ? ", with notes from similar tasks" : ""})</span>
        {ev.explored && <Badge tone="info" className="ml-1.5">exploring</Badge>}
        <button className="ml-2 cursor-pointer text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen(!open)}>
          {open ? "▾ why" : "▸ why"}
        </button>
      </div>
      {open && (
        <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
          {(ev.why as string[]).map((w) => (
            <li key={w}>{w}</li>
          ))}
          {(ev.alternatives as Array<{ agent: string; score: number }>).length > 0 && <li>next best: {(ev.alternatives as Array<{ agent: string; score: number }>).map((a) => `${a.agent} (${a.score})`).join(", ")}</li>}
        </ul>
      )}
    </Row>
  );
}

/** An agent's question. Its text is model output: shown as plain text, labelled, never linkified. */
function QuestionItem({ q, answered }: { q: Ev; answered?: Ev }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (answer: string) => {
    if (!answer.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/api/runs/${q._runId}/questions/${q.id}`, { answer });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const choices: string[] = Array.isArray(q.choices) ? q.choices : [];
  return (
    <div className={cn("rounded-lg border-2 px-4 py-3", answered ? "border-border bg-card" : "border-primary bg-accent/50")}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <CircleHelp className="size-4 text-primary" />
        <b>{q.agent} asks</b>
        <span className="text-xs text-muted-foreground">written by the AI · never share passwords or keys</span>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap">{q.question}</p>
      {answered ? (
        <p className="mt-2 flex items-center gap-1.5 text-sm">
          {answered.answer === null ? (
            <span className="text-muted-foreground">No answer ({answered.by}); the agent carried on.</span>
          ) : (
            <>
              <User className="size-3.5 text-muted-foreground" /> <b>You:</b> <span className="whitespace-pre-wrap">{answered.answer}</span>
            </>
          )}
        </p>
      ) : (
        <div className="mt-2.5 flex flex-col gap-2">
          {choices.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {choices.map((c) => (
                <Button key={c} variant="outline" size="sm" disabled={busy} onClick={() => void send(c)}>
                  {c}
                </Button>
              ))}
            </div>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send(text);
            }}
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={choices.length ? "…or type your own answer" : "Your answer"}
              className="h-8 flex-1 rounded-md border bg-background px-2.5 text-sm"
              disabled={busy}
              aria-label="Your answer"
            />
            <Button size="sm" type="submit" disabled={busy || !text.trim()}>
              <Send /> Answer
            </Button>
          </form>
          {error && <span className="text-xs text-bad">{error}</span>}
        </div>
      )}
    </div>
  );
}

function ApprovalItem({ req, resolved }: { req: Ev; resolved?: Ev }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (approved: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/api/runs/${req._runId}/approvals/${req.id}`, { approved });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className={cn("rounded-lg border-2 px-4 py-3", resolved ? "border-border bg-card" : "border-bad bg-bad-soft")}>
      <div className="flex flex-wrap items-center gap-2">
        <ShieldAlert className="size-4 text-bad" />
        <b>Approval needed:</b>
        {Array.isArray(req.chain) && req.chain.length > 1 && (
          <span className="text-sm">
            you → {req.chain.join(" → ")} wants to run
          </span>
        )}
        <span className="font-mono text-[13px] font-semibold">{req.tool}</span>
        <StatusBadge value={req.risk} />
        {req.reason === "rule" && <Badge tone="warn">agent rule: always ask</Badge>}
      </div>
      {req.history && (req.history.approved > 0 || req.history.denied > 0) && (
        <p className="mt-1 text-xs text-muted-foreground">
          A.R.S.E.N.A.L: you approved {req.history.approved} and denied {req.history.denied} similar action{req.history.approved + req.history.denied === 1 ? "" : "s"} before. The choice is yours.
        </p>
      )}
      <Pre>{pretty(req.input)}</Pre>
      <div className="mt-3 flex items-center gap-2">
        {resolved ? (
          <>
            <StatusBadge value={resolved.approved ? "approved" : "denied"} />
            <span className="text-xs text-muted-foreground">by {resolved.by}</span>
          </>
        ) : (
          <>
            <Button variant="success" disabled={busy} onClick={() => decide(true)}>
              <CircleCheck /> Approve
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => decide(false)}>
              <CircleX /> Deny
            </Button>
            {error && <span className="text-xs text-bad">{error}</span>}
          </>
        )}
      </div>
    </div>
  );
}

function EventItem({ ev }: { ev: RunEvent }) {
  switch (ev.type) {
    case "attempt":
      return (
        <Row tone="info" icon={<Bot />}>
          Using <b>{ev.label}</b> · <code className="font-mono text-xs">{ev.model}</code>
          {ev.attempt > 1 ? ` (attempt ${ev.attempt})` : ""}
        </Row>
      );
    case "arsenal_decision":
      return <ArsenalDecisionRow ev={ev} />;
    case "arsenal_notes":
      return (
        <div className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
          <Orb size={14} className="-my-1" /> A.R.S.E.N.A.L added notes from similar earlier tasks
        </div>
      );
    case "user_message":
      return (
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-lg rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
            <span className="mr-1.5 text-xs opacity-80">{ev.followUpOf ? "You (follow-up)" : "You"}</span>
            <span className="whitespace-pre-wrap">{ev.text}</span>
          </div>
        </div>
      );
    case "user_message_delivered":
      return (
        <div className="flex items-center justify-end gap-1 px-1 text-xs text-muted-foreground">
          <Check className="size-3.5" /> the agent read your message{ev.count > 1 ? "s" : ""}
        </div>
      );
    case "start":
      return (
        <div className="px-1 text-xs text-muted-foreground">
          Run {ev.runId} · {ev.tools.length} tools available
          {Array.isArray(ev.attachments) && ev.attachments.length > 0 && ` · files: ${ev.attachments.join(", ")}`}
        </div>
      );
    case "thinking":
      return (
        <Row tone="muted" icon={<Brain />} className="text-muted-foreground italic">
          <span className="whitespace-pre-wrap">{ev.text}</span>
        </Row>
      );
    case "text":
      return (
        <Row tone="info" icon={<Bot />}>
          <div className="whitespace-pre-wrap">{ev.text}</div>
        </Row>
      );
    case "turn":
      return (
        <div className="px-1 text-xs text-muted-foreground">
          step {ev.step} · in {fmtNum(ev.usage.inputTokens)} · cached {fmtNum(ev.usage.cacheReadTokens)} · out {fmtNum(ev.usage.outputTokens)} · {ev.servedBy}
        </div>
      );
    case "savings": {
      const parts = [
        ev.prunedTokens > 0 && `${fmtNum(ev.prunedTokens)} by dropping stale screen/page dumps`,
        ev.spilledTokens > 0 && `${fmtNum(ev.spilledTokens)} by shortening long results`,
        ev.compactTokens > 0 && `${fmtNum(ev.compactTokens)} by compact formatting`,
      ].filter(Boolean);
      return (
        <div className="px-1 text-xs text-ok" title="Estimated input tokens kept out of the model's context">
          saved ~{fmtNum(ev.prunedTokens + ev.spilledTokens + ev.compactTokens)} tokens: {parts.join(" · ")}
        </div>
      );
    }
    case "fallback":
      return (
        <Row tone="info" icon={<ArrowRightLeft />}>
          <b>{ev.from}</b> couldn't start ({ev.reason}). Falling back to <b>{ev.to}</b>.
        </Row>
      );
    case "stopping":
      return <Row tone="warn">Stopping after the current step…</Row>;
    case "end": {
      const s = ev.summary;
      return (
        <Row tone={s.status === "completed" ? "ok" : "bad"}>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge value={s.status} />
            <span className="text-xs text-muted-foreground">
              {s.steps} steps
              {s.usage && ` · in ${fmtNum(s.usage.inputTokens)} + cached ${fmtNum(s.usage.cacheReadTokens)} · out ${fmtNum(s.usage.outputTokens)}`}
            </span>
          </div>
          {s.error && <div className="mt-1 text-xs text-muted-foreground">{s.error}</div>}
        </Row>
      );
    }
    default:
      return null;
  }
}

const STEP_ICON: Record<string, ReactNode> = {
  done: <CircleCheck className="text-ok" />,
  failed: <CircleX className="text-bad" />,
  skipped: <MinusCircle className="text-muted-foreground" />,
  running: <LoaderCircle className="animate-spin text-primary" />,
};

/** The agent's latest plan (plan.update), shown as a live checklist. */
function PlanCard({ plan }: { plan: Ev }) {
  const steps = (plan.steps ?? []) as Array<{ task: string; agent?: string; status: string; note?: string }>;
  const done = steps.filter((s) => s.status === "done").length;
  return (
    <div className="rounded-lg border bg-card px-3.5 py-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <ListChecks className="size-4 text-primary" /> Plan
        <span className="text-xs font-normal text-muted-foreground">
          {done} of {steps.length} done
        </span>
      </div>
      <ol className="flex flex-col gap-1.5">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 [&_svg]:size-4">{STEP_ICON[s.status] ?? <Circle className="text-muted-foreground" />}</span>
            <div className="min-w-0">
              <span className={s.status === "skipped" ? "text-muted-foreground line-through" : undefined}>{s.task}</span>
              {s.agent && <span className="ml-2 font-mono text-xs text-primary">{s.agent}</span>}
              {s.note && <div className="text-xs text-muted-foreground">{s.note}</div>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** A run this agent handed a sub-task to, with its own steps nested inside. */
function DelegateItem({ start, end, items, plan }: { start: Ev; end?: Ev; items: Item[]; plan?: Ev }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-lg border border-primary/40 bg-accent/30">
      <div className="flex flex-wrap items-center gap-2 px-3.5 py-2.5">
        <Users className="size-4 text-primary" />
        <span>
          Handed to <b>{start.agent}</b>
        </span>
        <StatusBadge value={end?.status ?? "running"} />
        {end && <span className="text-xs text-muted-foreground">{end.steps} steps</span>}
        <Link className="text-xs text-primary hover:underline" to={`/runs/${start.runId}`}>
          open run
        </Link>
        <button className="ml-auto cursor-pointer text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen(!open)}>
          {open ? "▾ hide steps" : `▸ show ${items.length} steps`}
        </button>
      </div>
      <div className="px-3.5 pb-2 text-sm whitespace-pre-wrap text-muted-foreground">{start.task}</div>
      {open && items.length > 0 && (
        <div className="ml-3.5 flex flex-col gap-2 border-l-2 border-primary/30 py-2 pr-3 pl-3">
          {plan && <PlanCard plan={plan} />}
          <Items items={items} />
        </div>
      )}
    </div>
  );
}

function Items({ items }: { items: Item[] }) {
  return (
    <div className="flex flex-col gap-2">
      {items.map((it) =>
        it.kind === "tool" ? (
          <ToolItem key={it.call._key} call={it.call} result={it.result} />
        ) : it.kind === "approval" ? (
          <ApprovalItem key={it.req._key} req={it.req} resolved={it.resolved} />
        ) : it.kind === "question" ? (
          <QuestionItem key={it.q._key} q={it.q} answered={it.answered} />
        ) : it.kind === "delegate" ? (
          <DelegateItem key={it.start._key} start={it.start} end={it.end} items={it.items} plan={it.plan} />
        ) : (
          <EventItem key={it.ev._key} ev={it.ev} />
        ),
      )}
    </div>
  );
}

export function Timeline({ events }: { events: Ev[] }) {
  const plan = latestPlan(events.filter((e) => e.type !== "sub"));
  return (
    <div className="flex flex-col gap-2">
      {plan && <PlanCard plan={plan} />}
      <Items items={buildItems(events)} />
    </div>
  );
}
