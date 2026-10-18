import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { PageHeader, useMeta } from "@/components/Layout";
import { Timeline } from "@/components/Timeline";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { useRunEvents } from "@/hooks/useRunEvents";
import { api, get } from "@/lib/api";
import type { AgentDefinition, ProvidersView } from "@/lib/types";
import { modelCache } from "@/pages/ProvidersPage";

export const ownConnection = (a: AgentDefinition) => a.model.connection ?? (a.model.provider === "anthropic" ? "anthropic" : "openai");

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

  // Re-attach to a run that is already in progress (e.g. after reopening the window).
  useEffect(() => {
    if (!runId && meta.data?.activeRunId) setRunId(meta.data.activeRunId);
  }, [meta.data?.activeRunId, runId]);

  const list = agents.data ?? [];
  const selected = list.find((a) => a.name === agent) ?? list[0];
  const stream = useRunEvents(runId);
  const running = !!runId && !stream.done;

  const start = useMutation({
    mutationFn: () => api<{ runId: string }>("POST", "/api/runs", { agent: selected!.name, task, connection: connection || undefined, model: model || undefined }),
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
        <Field label="Task" className="mt-4">
          <Textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && submit()}
            placeholder="What should the agent do?"
            className="min-h-20"
          />
        </Field>
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
