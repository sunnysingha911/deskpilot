import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, KeyRound, RefreshCw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/Layout";
import { useToast } from "@/components/Toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, get } from "@/lib/api";
import type { Connection, ProvidersView } from "@/lib/types";

/** Model ids per connection, filled by "Test & list models" (shared with the Run and editor screens). */
export const modelCache = new Map<string, string[]>();

export async function loadModels(id: string): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  const r = await api<{ ok: true; models: string[] } | { ok: false; error: string }>("POST", `/api/providers/${id}/test`).catch((e) => ({ ok: false as const, error: (e as Error).message }));
  if (r.ok) modelCache.set(id, r.models);
  return r;
}

const ready = (c: Connection) => c.enabled && c.keySet && !!c.defaultModel;

function ConnectionCard({ c }: { c: Connection }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(c.baseUrl ?? "");
  const [model, setModel] = useState(c.defaultModel);
  const [enabled, setEnabled] = useState(c.enabled);
  const [models, setModels] = useState(modelCache.get(c.id) ?? []);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      if (key.trim()) await api("PUT", `/api/providers/${c.id}/key`, { key: key.trim() });
      await api("PUT", `/api/providers/${c.id}`, { defaultModel: model, enabled, ...(c.kind !== "anthropic" && { baseUrl }) });
    },
    onSuccess: () => {
      setKey("");
      toast(`Saved ${c.label}`);
      qc.invalidateQueries({ queryKey: ["providers"] });
    },
    onError: (e) => toast((e as Error).message, true),
  });
  const runTest = useMutation({
    mutationFn: () => loadModels(c.id),
    onSuccess: (r) => {
      if (r.ok) {
        setModels(r.models);
        setTest({ ok: true, text: `${r.models.length} models available. Pick one as the default model.` });
      } else setTest({ ok: false, text: r.error });
    },
  });

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <CardTitle>{c.label}</CardTitle>
        {c.keyEnv ? <Badge tone={c.keySet ? "ok" : "bad"}>{c.keySet ? "key set" : "no key"}</Badge> : <Badge tone="ok">no key needed</Badge>}
        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          enabled <Switch checked={enabled} onCheckedChange={setEnabled} />
        </label>
      </div>
      {c.keyEnv && (
        <Field label={`API key (${c.keyEnv})`} hint="Saved to .env on this machine and never shown again.">
          <Input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={c.keySet ? "•••••••• set; paste to replace" : "paste key"} />
        </Field>
      )}
      {c.kind !== "anthropic" && (
        <Field label="Base URL">
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </Field>
      )}
      <Field label="Default model">
        <Input value={model} onChange={(e) => setModel(e.target.value)} list={`models-${c.id}`} placeholder="model id" />
        <datalist id={`models-${c.id}`}>
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </Field>
      <div className="flex gap-2">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          <Save /> Save
        </Button>
        <Button variant="outline" onClick={() => runTest.mutate()} disabled={runTest.isPending}>
          <RefreshCw className={runTest.isPending ? "animate-spin" : ""} /> Test & list models
        </Button>
      </div>
      {test && <p className={test.ok ? "text-xs text-ok" : "text-xs text-bad"}>{test.text}</p>}
    </Card>
  );
}

function Routing({ view }: { view: ProvidersView }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [order, setOrder] = useState(view.settings.providerOrder);
  const [fallback, setFallback] = useState(view.settings.fallbackOnStartFailure);
  useEffect(() => setOrder(view.settings.providerOrder), [view.settings.providerOrder]);
  const move = (i: number, d: -1 | 1) => setOrder((o) => {
    const n = [...o];
    [n[i], n[i + d]] = [n[i + d]!, n[i]!];
    return n;
  });
  const save = useMutation({
    mutationFn: () => api("PUT", "/api/providers/settings", { providerOrder: order, fallbackOnStartFailure: fallback }),
    onSuccess: () => {
      toast("Routing saved");
      qc.invalidateQueries({ queryKey: ["providers"] });
    },
    onError: (e) => toast((e as Error).message, true),
  });
  return (
    <Card className="mb-4">
      <CardTitle>Routing</CardTitle>
      <p className="mt-1 mb-3 text-xs text-muted-foreground">
        If a run uses the agent's default provider and it can't start (no key, no credits, unreachable), deskpilot retries on the next ready provider in this order. It
        never falls back once a step has run, and choosing a provider on the Run screen turns fallback off for that run.
      </p>
      <div className="divide-y">
        {order.map((id, i) => {
          const c = view.connections.find((x) => x.id === id);
          return (
            <div key={id} className="flex items-center gap-3 py-2">
              <span className="w-5 text-muted-foreground">{i + 1}.</span>
              <span>{c?.label ?? id}</span>
              {c && (ready(c) ? <Badge tone="ok">ready</Badge> : <Badge tone="bad">{!c.keySet ? "no key" : !c.defaultModel ? "no model" : "disabled"}</Badge>)}
              <div className="ml-auto flex gap-1">
                <Button variant="outline" size="icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label="move up">
                  <ArrowUp />
                </Button>
                <Button variant="outline" size="icon" disabled={i === order.length - 1} onClick={() => move(i, 1)} aria-label="move down">
                  <ArrowDown />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <Switch checked={fallback} onCheckedChange={setFallback} /> Fall back to the next provider if a run can't start
      </label>
      <Button className="mt-3" onClick={() => save.mutate()} disabled={save.isPending}>
        <Save /> Save routing
      </Button>
    </Card>
  );
}

export function ProvidersPage() {
  const prov = useQuery({ queryKey: ["providers"], queryFn: () => get<ProvidersView>("/api/providers") });
  if (!prov.data) return null;
  return (
    <>
      <PageHeader title="Providers" sub="Connect the AIs your agents can use. Keys stay in .env on this machine." />
      <Routing view={prov.data} />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
        {prov.data.connections.map((c) => (
          <ConnectionCard key={`${c.id}:${c.keySet}:${c.defaultModel}`} c={c} />
        ))}
      </div>
      <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
        <KeyRound className="size-3.5" /> Keys are write-only: this screen can set or replace them but never reads them back.
      </p>
    </>
  );
}
