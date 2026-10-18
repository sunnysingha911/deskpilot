import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Forward, Play, Square, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { parseMentions } from "../../../src/agent/schema.ts";
import { PageHeader, useMeta } from "@/components/Layout";
import { Timeline } from "@/components/Timeline";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { useRunEvents } from "@/hooks/useRunEvents";
import { api, get } from "@/lib/api";
import type { AgentDefinition, ProvidersView, RunDetail } from "@/lib/types";
import { modelCache } from "@/pages/ProvidersPage";

export const ownConnection = (a: AgentDefinition) =>
  a.model.connection ?? (a.model.provider === "anthropic" ? "anthropic" : a.model.provider === "ollama" ? "ollama" : "openai");

export function RunPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const meta = useMeta();
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => get<AgentDefinition[]>("/api/agents") });
  const prov = useQuery({ queryKey: ["providers"], queryFn: () => get<ProvidersView>("/api/providers") });

  const [agent, setAgent] = useState(() => localStorage.getItem("deskpilot-last-agent") ?? "");
  const [connection, setConnection] = useState("");
  const [model, setModel] = useState("");
  const [task, setTask] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [withAgents, setWithAgents] = useState<string[]>([]);
  // "Send to agent…" on a finished run opens this page with ?from=<runId>.
  const [params, setParams] = useSearchParams();
  const fromRun = params.get("from");
  const from = useQuery({ queryKey: ["run", fromRun], queryFn: () => get<RunDetail>(`/api/runs/${fromRun}`), enabled: !!fromRun });

  // Re-attach to a run that is already in progress (e.g. after reopening the window).
  useEffect(() => {
    if (!runId && meta.data?.activeRunId) setRunId(meta.data.activeRunId);
  }, [meta.data?.activeRunId, runId]);

  const list = agents.data ?? [];
  const selected = list.find((a) => a.name === agent) ?? list[0];
  const stream = useRunEvents(runId);
  const running = !!runId && !stream.done;

  const start = useMutation({
    mutationFn: () =>
      api<{ runId: string }>("POST", "/api/runs", {
        agent: selected!.name,
        task,
        connection: connection || undefined,
        model: model || undefined,
        with: withAgents.filter((n) => n !== selected!.name && list.some((a) => a.name === n)),
        fromRun: fromRun || undefined,
      }),
    onSuccess: ({ runId }) => {
      localStorage.setItem("deskpilot-last-agent", selected!.name);
      setRunId(runId);
      qc.invalidateQueries({ queryKey: ["meta"] });
    },
    onError: (e) => toast((e as Error).message, true),
  });
  const stop = useMutation({
    mutationFn: () => api("POST", `/api/runs/${stream.currentRunId}/stop`),
    onError: (e) => toast((e as Error).message, true),
  });

  useEffect(() => {
    if (stream.done) qc.invalidateQueries({ queryKey: ["meta"] });
  }, [stream.done, qc]);
  useEffect(() => {
    const resolved = new Set(stream.events.filter((e) => e.type === "approval_resolved").map((e) => `${e._runId}:${e.id}`));
    const pending = stream.events.some((e) => e.type === "approval_request" && !resolved.has(`${e._runId}:${e.id}`));
    document.title = pending ? "⚠️ Approval needed · deskpilot" : "deskpilot";
  }, [stream.events]);

  const others = list.filter((a) => a.name !== selected?.name);
  const mentioned = useMemo(() => parseMentions(task, list.map((a) => a.name), selected?.name), [task, list, selected?.name]);
  const models = useMemo(() => modelCache.get(connection || (selected ? ownConnection(selected) : "")) ?? [], [connection, selected]);

  if (agents.isLoading) return null;
  if (!list.length)
    return (
      <>
        <PageHeader title="Run a task" />
        <Card className="py-10 text-center text-muted-foreground">
          No agents yet. <Link className="text-primary hover:underline" to="/agents/new">Create one</Link>
        </Card>
      </>
    );

  const submit = () => {
    if (!task.trim()) return toast("Describe the task first", true);
    start.mutate();
  };

  return (
    <>
      <PageHeader title="Run a task" sub="Pick an agent, optionally choose which AI runs it, and watch every step. Irreversible actions wait for your approval here." />
      <Card>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Agent">
            <NativeSelect value={selected?.name} onChange={(e) => setAgent(e.target.value)} disabled={running}>
              {list.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="AI provider">
            <NativeSelect value={connection} onChange={(e) => setConnection(e.target.value)} disabled={running}>
              <option value="">Agent default ({selected ? `${ownConnection(selected)} · ${selected.model.id}` : "…"})</option>
              {prov.data?.connections
                .filter((c) => c.enabled)
                .map((c) => (
                  <option key={c.id} value={c.id} disabled={!c.keySet}>
                    {c.label}
                    {c.defaultModel ? ` · ${c.defaultModel}` : ""}
                    {c.keySet ? "" : " (no key)"}
                  </option>
                ))}
            </NativeSelect>
          </Field>
          <Field label="Model">
            <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="optional override" list="run-models" disabled={running} />
            <datalist id="run-models">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </Field>
        </div>
        {selected && (
          <p className="mt-2 text-xs text-muted-foreground">
            {selected.description || "—"} · tools: {selected.tools.join(", ")}
          </p>
        )}
        {fromRun && (
          <div className="mt-4 flex items-start gap-2 rounded-md border border-primary/40 bg-accent/40 p-3 text-sm">
            <Forward className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              Continuing from{" "}
              <Link className="text-primary hover:underline" to={`/runs/${fromRun}`}>
                {from.data ? `${from.data.run.agent}'s run` : fromRun}
              </Link>
              . Its final answer is passed to the agent as data, after your task.
              {from.data?.run.final_text && <div className="mt-1 line-clamp-3 text-xs whitespace-pre-wrap text-muted-foreground">{from.data.run.final_text}</div>}
            </div>
            <button className="cursor-pointer text-muted-foreground hover:text-foreground" title="Don't pass it on" onClick={() => setParams({})} disabled={running}>
              <X className="size-4" />
            </button>
          </div>
        )}
        <Field label="Task" className="mt-4">
          <Textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && submit()}
            placeholder="What should the agent do? Write @agent-name to let it hand part of the work to another agent."
            className="min-h-20"
          />
        </Field>
        {others.length > 0 && selected && (
          <div className="mt-3">
            <div className="text-xs font-medium text-muted-foreground">Agents it may hand work to in this run</div>
            <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1.5">
              {others.map((a) => {
                const always = selected.canDelegateTo.includes(a.name);
                const viaMention = mentioned.includes(a.name);
                const on = always || viaMention || withAgents.includes(a.name);
                return (
                  <label key={a.name} className="flex cursor-pointer items-center gap-1.5 text-sm" title={a.description}>
                    <Checkbox
                      checked={on}
                      disabled={always || viaMention || running}
                      onCheckedChange={(v) => setWithAgents((w) => (v ? [...new Set([...w, a.name])] : w.filter((n) => n !== a.name)))}
                    />
                    <span className="font-mono text-[13px]">{a.name}</span>
                    {always && <Badge>always</Badge>}
                    {viaMention && !always && <Badge tone="info">@mentioned</Badge>}
                  </label>
                );
              })}
            </div>
          </div>
        )}
        <div className="mt-4 flex items-center gap-2">
          <Button onClick={submit} disabled={running || start.isPending}>
            <Play /> Start
          </Button>
          {running && (
            <Button variant="destructive" onClick={() => stop.mutate()} disabled={stop.isPending}>
              <Square /> Stop
            </Button>
          )}
          <span className="text-xs text-muted-foreground">⌘↩ to start</span>
          {runId && (
            <Link className="ml-auto text-xs text-primary hover:underline" to={`/runs/${stream.currentRunId ?? runId}`}>
              open in Runs
            </Link>
          )}
        </div>
      </Card>
      {runId && (
        <div className="mt-4">
          <Timeline events={stream.events} />
        </div>
      )}
    </>
  );
}
