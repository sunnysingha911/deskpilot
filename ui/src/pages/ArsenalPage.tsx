// A.R.S.E.N.A.L: what it has learned, what it suggests, what it changed (with undo), and its settings.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, RotateCcw, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/Layout";
import { Orb } from "@/components/Orb";
import { useToast } from "@/components/Toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, NativeSelect } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { api, get } from "@/lib/api";
import { fmtNum, fmtTime } from "@/lib/format";
import type { ArsenalChange, ArsenalDecision, ArsenalReport, ArsenalSettings, ArsenalSuggestion } from "@/lib/types";

const PRESETS = ["#ff8a1f", "#22d3ee", "#f43f5e", "#34d399", "#a78bfa", "#facc15"];
const PATCHABLE = ["budget.maxSteps", "budget.maxOutputTokens", "budget.maxSeconds", "model.connection", "model.id"];
const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);
const score = (x: number | null) => (x === null ? "–" : x.toFixed(2));
const getPath = (o: Record<string, unknown>, p: string): unknown => p.split(".").reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined), o);

function diff(c: ArsenalChange): string {
  return PATCHABLE.filter((p) => JSON.stringify(getPath(c.before, p)) !== JSON.stringify(getPath(c.after, p)))
    .map((p) => `${p}: ${JSON.stringify(getPath(c.before, p)) ?? "–"} → ${JSON.stringify(getPath(c.after, p)) ?? "–"}`)
    .join(", ");
}

function SuggestionRow({ s, onAct }: { s: ArsenalSuggestion; onAct: (id: number, action: "apply" | "reject") => void }) {
  const status = {
    open: null,
    applied: s.trial ? <Badge tone="info">trying it: {s.trial.rewards.length}/5 tasks</Badge> : <Badge>noted</Badge>,
    kept: <Badge tone="ok">kept: worked as well or better</Badge>,
    reverted: <Badge tone="warn">reverted</Badge>,
    rejected: <Badge>rejected</Badge>,
  }[s.status];
  return (
    <div className="flex items-start gap-3 border-b py-2.5 last:border-b-0">
      <Badge tone={s.kind === "health" ? "bad" : "info"}>{s.kind}</Badge>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{s.title}</div>
        <div className="text-xs text-muted-foreground">{s.rationale}</div>
        {s.patch && <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{Object.entries(s.patch).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ")}</div>}
      </div>
      {s.status === "open" ? (
        <div className="flex shrink-0 gap-1.5">
          <Button size="sm" variant="success" onClick={() => onAct(s.id, "apply")}>
            <Check /> {s.patch ? "Apply" : "Got it"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => onAct(s.id, "reject")}>
            <X /> Reject
          </Button>
        </div>
      ) : (
        <div className="shrink-0">{status}</div>
      )}
    </div>
  );
}

function TryIt({ color }: { color: string }) {
  const [task, setTask] = useState("");
  const [d, setD] = useState<ArsenalDecision | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (task.trim().length < 4) return setD(null);
    const t = setTimeout(() => {
      api<ArsenalDecision>("POST", "/api/arsenal/decide", { task })
        .then((x) => (setD(x), setErr(null)))
        .catch((e) => setErr((e as Error).message));
    }, 350);
    return () => clearTimeout(t);
  }, [task]);
  return (
    <Card>
      <CardTitle className="mb-2">Ask how it would handle a task</CardTitle>
      <Input id="arsenal-ask" value={task} onChange={(e) => setTask(e.target.value)} placeholder="e.g. find remote rust jobs in Berlin" />
      {err && <p className="mt-2 text-xs text-bad">{err}</p>}
      {d && <DecisionView d={d} color={color} />}
    </Card>
  );
}

export function DecisionView({ d, color, compact }: { d: ArsenalDecision; color: string; compact?: boolean }) {
  return (
    <div className="mt-3 flex gap-3">
      {!compact && <Orb color={color} state="talking" size={44} className="shrink-0" />}
      <div className="min-w-0 text-sm">
        <div>
          Would send <b>{d.agent}</b>
          {d.connection ? ` on ${d.connection} · ${d.model}` : ""} · <span className="capitalize">{d.mode}</span> · {d.priority} priority ·{" "}
          <span className="text-muted-foreground">{Math.round(d.confidence * 100)}% sure</span>
          {d.explored && <Badge tone="info" className="ml-1.5">exploring</Badge>}
        </div>
        <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
          {d.why.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
        {d.alternatives.length > 0 && <div className="mt-1 text-xs text-muted-foreground">Next best: {d.alternatives.map((a) => `${a.agent} (${a.score.toFixed(2)})`).join(", ")}</div>}
      </div>
    </div>
  );
}

export function ArsenalPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const report = useQuery({ queryKey: ["arsenal"], queryFn: () => get<ArsenalReport>("/api/arsenal"), refetchInterval: 5000 });
  const [draft, setDraft] = useState<ArsenalSettings | null>(null);
  useEffect(() => {
    if (report.data && !draft) setDraft(report.data.settings);
  }, [report.data, draft]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["arsenal"] });
  const act = useMutation({
    mutationFn: (v: { id: number; action: "apply" | "reject" }) => api("POST", `/api/arsenal/suggestions/${v.id}`, { action: v.action }),
    onSuccess: (_d, v) => (toast(v.action === "apply" ? "Applied. A.R.S.E.N.A.L will watch the next tasks and undo it if they go worse." : "Rejected"), refresh()),
    onError: (e) => toast((e as Error).message, true),
  });
  const undo = useMutation({
    mutationFn: (id: number) => api("POST", `/api/arsenal/changes/${id}/undo`),
    onSuccess: () => (toast("Undone"), refresh()),
    onError: (e) => toast((e as Error).message, true),
  });
  const save = useMutation({
    mutationFn: (s: ArsenalSettings) => api<ArsenalSettings>("PUT", "/api/arsenal/settings", s),
    onSuccess: (s) => (setDraft(s), toast("Saved"), refresh(), qc.invalidateQueries({ queryKey: ["arsenal-color"] })),
    onError: (e) => toast((e as Error).message, true),
  });

  const r = report.data;
  if (report.error) return <Card>{(report.error as Error).message}</Card>;
  if (!r || !draft) return null;
  const open = r.suggestions.filter((s) => s.status === "open");
  const past = r.suggestions.filter((s) => s.status !== "open");

  return (
    <>
      <PageHeader title={r.name} sub={r.expansion} />
      <Card className="flex flex-wrap items-center gap-6">
        <Orb
          color={draft.color}
          state={open.length ? "talking" : "idle"}
          size={140}
          interactive
          title="A.R.S.E.N.A.L: tap or press Enter to ask it about a task (hold to make it listen, double-tap to spin)"
          onActivate={() => {
            const box = document.getElementById("arsenal-ask");
            box?.scrollIntoView({ behavior: "smooth", block: "center" });
            box?.focus({ preventScroll: true });
          }}
        />
        <div className="flex flex-1 flex-wrap gap-x-8 gap-y-3">
          {[
            ["learned from", `${fmtNum(r.experiences)} tasks`],
            ["routed", `${fmtNum(r.routed)} tasks`],
            ["your ratings", fmtNum(r.rated)],
            ["average score", score(r.avgReward)],
            ["last learned", r.lastLearned ? fmtTime(r.lastLearned) : "not yet"],
          ].map(([k, v]) => (
            <div key={k}>
              <div className="text-xs text-muted-foreground">{k}</div>
              <div className="text-lg font-semibold">{v}</div>
            </div>
          ))}
          <p className="w-full text-xs text-muted-foreground">
            Learns from every task you run, its own picks and yours. It runs on this Mac with no AI provider. It may change only agent budgets and models, and only after you approve. Each change is tried on 5 tasks and undone automatically if results drop. It can't touch tools, instructions or approvals.
          </p>
        </div>
      </Card>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle className="mb-1 flex items-center gap-1.5">
            <Sparkles className="size-4 text-primary" /> Suggestions {open.length > 0 && <Badge tone="info">{open.length} new</Badge>}
          </CardTitle>
          {open.length === 0 && <p className="py-2 text-sm text-muted-foreground">Nothing to suggest right now. Suggestions appear as it learns.</p>}
          {open.map((s) => (
            <SuggestionRow key={s.id} s={s} onAct={(id, action) => act.mutate({ id, action })} />
          ))}
          {past.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">Earlier suggestions ({past.length})</summary>
              {past.map((s) => (
                <SuggestionRow key={s.id} s={s} onAct={() => {}} />
              ))}
            </details>
          )}
        </Card>
        <TryIt color={draft.color} />
      </div>

      <Card className="mt-4">
        <CardTitle className="mb-2">What it knows about your agents</CardTitle>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="py-1">agent</th>
              <th>tasks</th>
              <th>finished</th>
              <th>score</th>
              <th>avg tokens out</th>
              <th>good at</th>
              <th>model</th>
            </tr>
          </thead>
          <tbody>
            {r.agents.map((a) => (
              <tr key={a.agent} className="border-t">
                <td className="py-1.5 font-medium">{a.agent}</td>
                <td>{a.runs}</td>
                <td>{pct(a.successRate)}</td>
                <td>{score(a.avgReward)}</td>
                <td>{a.avgOutputTokens === null ? "–" : fmtNum(a.avgOutputTokens)}</td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    {a.knownFor.map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                  </div>
                </td>
                <td className="font-mono text-xs text-muted-foreground">{a.model}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle className="mb-2">Providers it has seen</CardTitle>
          {r.providers.length === 0 && <p className="text-sm text-muted-foreground">No data yet.</p>}
          {r.providers.map((p) => (
            <div key={p.provider} className="flex items-center gap-3 border-t py-1.5 text-sm first:border-t-0">
              <span className="flex-1 font-mono text-xs">{p.provider}</span>
              <span className="text-xs text-muted-foreground">{p.runs} tasks</span>
              <span className="text-xs">score {p.avgReward.toFixed(2)}</span>
              <span className="text-xs text-muted-foreground">{fmtNum(p.avgOutputTokens)} tokens out</span>
            </div>
          ))}
        </Card>
        <Card>
          <CardTitle className="mb-2">Changes it made (with your OK)</CardTitle>
          {r.changes.length === 0 && <p className="text-sm text-muted-foreground">None yet.</p>}
          {r.changes.map((c) => (
            <div key={c.id} className="flex items-center gap-2 border-t py-1.5 text-sm first:border-t-0">
              <div className="min-w-0 flex-1">
                <div>
                  <b>{c.target}</b> <span className="font-mono text-xs">{diff(c) || "no field changes"}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {fmtTime(c.ts)} · {c.by}
                </div>
              </div>
              {c.undone ? (
                <Badge>undone</Badge>
              ) : c.suggestionId !== null ? (
                <Button size="sm" variant="outline" onClick={() => undo.mutate(c.id)}>
                  <RotateCcw /> Undo
                </Button>
              ) : null}
            </div>
          ))}
        </Card>
      </div>

      <Card className="mt-4">
        <CardTitle className="mb-3">Settings</CardTitle>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
          <Field label="Orb colour">
            <div className="flex items-center gap-2">
              {PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`colour ${c}`}
                  onClick={() => setDraft({ ...draft, color: c })}
                  className={`size-7 cursor-pointer rounded-full border-2 ${draft.color === c ? "border-foreground" : "border-transparent"}`}
                  style={{ background: c }}
                />
              ))}
              <Input type="color" value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })} className="w-12 p-1" aria-label="custom colour" />
            </div>
          </Field>
          <Field label="Memory" hint="Notes from similar earlier tasks, handed to agents as background (as data, never as instructions)">
            <NativeSelect value={draft.memory} onChange={(e) => setDraft({ ...draft, memory: e.target.value as ArsenalSettings["memory"] })}>
              <option value="routed">On tasks it routes</option>
              <option value="all">On every task</option>
              <option value="off">Off</option>
            </NativeSelect>
          </Field>
          <Field label="On the desktop" hint="Its orb stays on your desktop: click it to give it a task">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.desktop !== false} onChange={(e) => setDraft({ ...draft, desktop: e.target.checked })} className="size-4" />
              Always show A.R.S.E.N.A.L
            </label>
          </Field>
          <Field label={`Exploration: ${Math.round(draft.exploration * 100)}%`} hint="How often it tries a less-proven agent to keep learning">
            <input type="range" min={0} max={1} step={0.05} value={draft.exploration} onChange={(e) => setDraft({ ...draft, exploration: Number(e.target.value) })} className="w-full" />
          </Field>
        </div>
        <Button className="mt-4" onClick={() => save.mutate(draft)} disabled={save.isPending}>
          Save settings
        </Button>
      </Card>
    </>
  );
}
