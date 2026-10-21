import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Forward, Play, Plus, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { parseMentions } from "@/lib/schema.ts";
import { AttachmentPicker, NO_ATTACHMENTS, type AttachmentState } from "@/components/Attachments";
import { ChatBox } from "@/components/ChatBox";
import { Rating } from "@/components/Rating";
import { PageHeader, useArsenal, useMeta } from "@/components/Layout";
import { Orb } from "@/components/Orb";
import { DecisionView } from "@/pages/ArsenalPage";
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
import type { ActiveRun, AgentDefinition, ArsenalDecision, Priority, ProvidersView, RunDetail, RunMode } from "@/lib/types";
import { cn } from "@/lib/utils";
import { modelCache } from "@/pages/ProvidersPage";

export const ownConnection = (a: AgentDefinition) =>
  a.model.connection ?? (a.model.provider === "anthropic" ? "anthropic" : a.model.provider === "ollama" ? "ollama" : "openai");

export function RunPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const meta = useMeta();
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => get<AgentDefinition[]>("/api/agents") });
  const prov = useQuery({ queryKey: ["providers"], queryFn: () => get<ProvidersView>("/api/providers") });

  // "arsenal" = let A.R.S.E.N.A.L pick the agent, provider and run settings (the default for new users).
  const [agent, setAgent] = useState(() => localStorage.getItem("deskpilot-last-agent") ?? "arsenal");
  const isArsenal = agent === "arsenal";
  const arsenal = useArsenal();
  const orbColor = arsenal.data?.settings.color ?? "#ff8a1f";
  const [preview, setPreview] = useState<ArsenalDecision | null>(null);
  const [connection, setConnection] = useState("");
  const [model, setModel] = useState("");
  const [task, setTask] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  /** Agent of the watched run, remembered so the chat box can name it after the run finishes. */
  const [watchAgent, setWatchAgent] = useState<string | undefined>(undefined);
  const [withAgents, setWithAgents] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<AttachmentState>(NO_ATTACHMENTS);
  const [mode, setMode] = useState<RunMode>(() => (localStorage.getItem("deskpilot-run-mode") as RunMode | null) ?? "optimized");
  const [priority, setPriority] = useState<Priority>("normal");
  // "Send to agent…" on a finished run opens this page with ?from=<runId>.
  const [params, setParams] = useSearchParams();
  const fromRun = params.get("from");
  const from = useQuery({ queryKey: ["run", fromRun], queryFn: () => get<RunDetail>(`/api/runs/${fromRun}`), enabled: !!fromRun });

  // Watch a run that is already in progress (e.g. after reopening the window).
  useEffect(() => {
    if (!runId && meta.data?.activeRunId) {
      setRunId(meta.data.activeRunId);
      setWatchAgent(meta.data.activeRuns?.find((r) => r.runId === meta.data!.activeRunId)?.agent);
    }
  }, [meta.data?.activeRunId, runId]);
  const activeRuns = meta.data?.activeRuns ?? [];

  const list = agents.data ?? [];
  const selected = isArsenal ? undefined : (list.find((a) => a.name === agent) ?? list[0]);

  // What A.R.S.E.N.A.L would do with the task being typed.
  useEffect(() => {
    if (!isArsenal || task.trim().length < 4) return setPreview(null);
    const t = setTimeout(() => {
      api<ArsenalDecision>("POST", "/api/arsenal/decide", { task })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 400);
    return () => clearTimeout(t);
  }, [isArsenal, task]);
  const stream = useRunEvents(runId);

  const start = useMutation({
    mutationFn: () =>
      api<{ runId: string; decision?: ArsenalDecision }>("POST", "/api/runs", {
        agent: isArsenal ? "arsenal" : selected!.name,
        task,
        connection: connection || undefined,
        model: model || undefined,
        with: isArsenal ? undefined : withAgents.filter((n) => n !== selected!.name && list.some((a) => a.name === n)),
        fromRun: fromRun || undefined,
        attachments: attachments.files.length ? attachments.set : undefined,
        // A.R.S.E.N.A.L picks these itself.
        mode: isArsenal ? undefined : mode,
        priority: isArsenal ? undefined : priority,
      }),
    onSuccess: ({ runId, decision }) => {
      const who = decision?.agent ?? selected!.name;
      localStorage.setItem("deskpilot-last-agent", isArsenal ? "arsenal" : who);
      setRunId(runId);
      setWatchAgent(who);
      // The form is ready for the next task straight away (the files now belong to that run).
      clearForm();
      setPreview(null);
      toast(decision ? `A.R.S.E.N.A.L sent ${who}. You can start another task now.` : `Started ${who}. You can start another task now: it runs alongside.`);
      qc.invalidateQueries({ queryKey: ["meta"] });
    },
    onError: (e) => toast((e as Error).message, true),
  });
  const taskBox = useRef<HTMLTextAreaElement>(null);
  function clearForm() {
    setTask("");
    setAttachments(NO_ATTACHMENTS);
    setWithAgents([]);
    if (fromRun) setParams({});
  }
  const newTask = () => {
    clearForm();
    window.scrollTo({ top: 0, behavior: "smooth" });
    taskBox.current?.focus();
  };

  const stop = useMutation({
    mutationFn: (id: string) => api("POST", `/api/runs/${id}/stop`),
    onError: (e) => toast((e as Error).message, true),
  });
  const changePriority = useMutation({
    mutationFn: (v: { runId: string; priority: Priority }) => api("POST", `/api/runs/${v.runId}/priority`, { priority: v.priority }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["meta"] }),
    onError: (e) => toast((e as Error).message, true),
  });

  useEffect(() => {
    if (stream.done) qc.invalidateQueries({ queryKey: ["meta"] });
  }, [stream.done, qc]);

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
      <PageHeader
        title="Run a task"
        sub="Pick an agent and start a task. Start as many as you like: they run side by side, listed under Running now. Irreversible actions wait for your approval here."
        actions={
          <Button variant="outline" onClick={newTask} title="Clear the form to start another task (running tasks keep going)">
            <Plus /> New task
          </Button>
        }
      />
      <Card>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Agent">
            <NativeSelect value={isArsenal ? "arsenal" : selected?.name} onChange={(e) => setAgent(e.target.value)}>
              <option value="arsenal">✦ A.R.S.E.N.A.L: let it decide</option>
              {list.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="AI provider">
            <NativeSelect value={connection} onChange={(e) => setConnection(e.target.value)}>
              <option value="">{isArsenal ? "Let A.R.S.E.N.A.L choose" : `Agent default (${selected ? `${ownConnection(selected)} · ${selected.model.id}` : "…"})`}</option>
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
            <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="optional override" list="run-models" />
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
        {isArsenal && (
          <div className="mt-3 flex items-start gap-3 rounded-md border bg-muted/40 p-3">
            <Orb color={orbColor} state={preview ? "talking" : "idle"} size={48} className="-my-2 shrink-0" interactive onActivate={() => taskBox.current?.focus()} title="A.R.S.E.N.A.L: tap to type a task" />
            <div className="min-w-0 flex-1 text-sm">
              {preview ? (
                <DecisionView d={preview} color={orbColor} compact />
              ) : (
                <p className="text-muted-foreground">Describe the task: A.R.S.E.N.A.L picks the agent, the AI and how it runs, learning from every task.</p>
              )}
            </div>
          </div>
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
            <button className="cursor-pointer text-muted-foreground hover:text-foreground" title="Don't pass it on" onClick={() => setParams({})}>
              <X className="size-4" />
            </button>
          </div>
        )}
        <Field label="Task" className="mt-4">
          <AttachmentPicker value={attachments} onChange={setAttachments} disabled={start.isPending} onError={(m) => toast(m, true)}>
            <Textarea
              ref={taskBox}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && submit()}
              placeholder="What should the agent do? Write @agent-name to let it hand part of the work to another agent. Drop files here to attach them."
              className="min-h-20"
            />
          </AttachmentPicker>
        </Field>
        {others.length > 0 && selected && !isArsenal && (
          <div className="mt-3">
            <div className="text-xs font-medium text-muted-foreground">Agents it may hand work to in this run</div>
            <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1.5">
              {others.map((a) => {
                const always = selected.canDelegateTo.includes(a.name) || selected.canDelegateTo.includes("*");
                const viaMention = mentioned.includes(a.name);
                const on = always || viaMention || withAgents.includes(a.name);
                return (
                  <label key={a.name} className="flex cursor-pointer items-center gap-1.5 text-sm" title={a.description}>
                    <Checkbox
                      checked={on}
                      disabled={always || viaMention}
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
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={submit} disabled={start.isPending}>
            <Play /> {activeRuns.length ? "Start another task" : "Start task"}
          </Button>
          {isArsenal ? (
            <span className="text-xs text-muted-foreground">Mode and priority: chosen by A.R.S.E.N.A.L</span>
          ) : (
            <>
              <ModeSwitch
                value={mode}
                onChange={(m) => {
                  setMode(m);
                  localStorage.setItem("deskpilot-run-mode", m);
                }}
              />
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title={mode === "parallel" ? "Priority only matters in Optimized mode" : "Who gets the screen, keyboard and mouse first"}>
                Priority
                <NativeSelect value={priority} onChange={(e) => setPriority(e.target.value as Priority)} className="h-8 w-28 text-xs" disabled={mode === "parallel"}>
                  <option value="high">High</option>
                  <option value="normal">Normal</option>
                  <option value="low">Low</option>
                </NativeSelect>
              </label>
            </>
          )}
          <span className="text-xs text-muted-foreground">⌘↩ to start · tasks run side by side</span>
        </div>
      </Card>
      <RunningNow
        runs={activeRuns}
        watching={stream.currentRunId ?? runId}
        onWatch={(id) => {
          setRunId(id);
          setWatchAgent(activeRuns.find((r) => r.runId === id)?.agent);
        }}
        onStop={(id) => stop.mutate(id)}
        onPriority={(id, p) => changePriority.mutate({ runId: id, priority: p })}
      />
      {runId && (
        <div className="mt-4">
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Eye className="size-3.5" /> Watching {stream.done ? "finished run" : "run"} {stream.currentRunId ?? runId}
            {stream.done && <Rating runId={stream.currentRunId ?? runId} />}
            <Link className="ml-auto text-primary hover:underline" to={`/runs/${stream.currentRunId ?? runId}`}>
              open in Runs
            </Link>
          </div>
          <Timeline events={stream.events} />
          <ChatBox
            runId={stream.currentRunId ?? runId}
            agent={watchAgent ?? activeRuns.find((r) => r.runId === (stream.currentRunId ?? runId))?.agent}
            running={!stream.done}
            onFollowUp={(id) => {
              setRunId(id);
              qc.invalidateQueries({ queryKey: ["meta"] });
            }}
          />
        </div>
      )}
    </>
  );
}

const MODE_HELP: Record<RunMode, string> = {
  optimized: "Runs alongside other tasks; when it uses the screen, keyboard or mouse it keeps them for a few seconds so its steps aren't interrupted. Priority decides who goes first.",
  parallel: "Runs alongside other tasks with no holding: each screen/keyboard/mouse action takes its turn on its own. Fastest; best for shell, browser and thinking-heavy tasks.",
};

function ModeSwitch({ value, onChange }: { value: RunMode; onChange: (m: RunMode) => void }) {
  return (
    <div className="inline-flex rounded-md border p-0.5" role="radiogroup" aria-label="Run mode">
      {(["optimized", "parallel"] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={value === m}
          title={MODE_HELP[m]}
          onClick={() => onChange(m)}
          className={cn("cursor-pointer rounded px-2.5 py-1 text-xs capitalize", value === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

/** Every task running right now: watch it, change its priority, stop it. */
function RunningNow({
  runs,
  watching,
  onWatch,
  onStop,
  onPriority,
}: {
  runs: ActiveRun[];
  watching: string | null;
  onWatch: (runId: string) => void;
  onStop: (runId: string) => void;
  onPriority: (runId: string, p: Priority) => void;
}) {
  return (
    <Card className="mt-4 py-3">
      <div className="mb-2 text-xs font-medium text-muted-foreground">Running now · {runs.length}</div>
      {!runs.length && <p className="px-2 text-sm text-muted-foreground">Nothing running. Every task you start appears here and runs alongside the others.</p>}
      <div className="flex flex-col gap-1">
        {runs.map((r) => (
          <div key={r.taskId} className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-sm", watching === r.runId && "bg-accent/60")}>
            <button type="button" className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left" onClick={() => onWatch(r.runId)} title="Watch this task">
              <b className="shrink-0">{r.agent}</b>
              <span className="truncate text-xs text-muted-foreground">{r.task}</span>
            </button>
            {r.pendingApprovals > 0 && <Badge tone="warn">needs your OK</Badge>}
            {r.pendingQuestions > 0 && <Badge tone="info">needs your answer</Badge>}
            <Badge>{r.mode}</Badge>
            <NativeSelect
              value={r.priority}
              onChange={(e) => onPriority(r.runId, e.target.value as Priority)}
              className="h-8 w-28 py-0 text-xs"
              disabled={r.mode === "parallel"}
              aria-label={`Priority of ${r.agent}`}
            >
              <option value="high">High</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </NativeSelect>
            <Button variant="outline" size="sm" onClick={() => onStop(r.runId)} aria-label={`Stop ${r.agent}`}>
              <Square /> Stop
            </Button>
          </div>
        ))}
      </div>
    </Card>
  );
}
