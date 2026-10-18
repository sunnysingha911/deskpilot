import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MonitorUp, RefreshCw, Save, Shuffle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate, useParams } from "react-router";
import { ACCESSORIES, AgentDefinition, type AvatarLook, BACK_ITEMS, defaultLook, HAIR_STYLES, matchesPattern, OUTFITS, SKIN_TONES } from "../../../src/agent/schema.ts";
import { Avatar, MOOD_LIST, SKIN, type Mood } from "@/components/Avatar";
import { PageHeader, useMeta } from "@/components/Layout";
import { useToast } from "@/components/Toast";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { api, get } from "@/lib/api";
import { familyOf } from "@/lib/format";
import type { ProvidersView, ToolInfo } from "@/lib/types";
import { loadModels, modelCache } from "@/pages/ProvidersPage";
import { ownConnection } from "@/pages/RunPage";

interface FormValues {
  name: string;
  description: string;
  system: string;
  connection: string;
  modelId: string;
  effort: string;
  maxTokensPerTurn: number;
  maxSteps: number;
  maxOutputTokens: number;
  maxSeconds: number;
  tools: string[];
  alwaysAsk: string[];
  canDelegateTo: string[];
  askDelegate: boolean;
  readOnlyFreely: boolean;
  avatar: AvatarLook;
}

/** The delegation tool isn't in the OS tool list, so its "ask" rule is kept separately. */
const DELEGATE_TOOL = "agent.delegate";

const BLANK: AgentDefinition = {
  name: "",
  description: "",
  system: "",
  tools: ["shell.run", "applescript.run", "ui.*"],
  model: { provider: "openai-compatible", connection: "openai", id: "", maxTokensPerTurn: 16_000 },
  budget: { maxSteps: 20, maxOutputTokens: 60_000, maxSeconds: 300 },
  approval: { alwaysAsk: [] },
  canDelegateTo: [],
};

/** Expand globs ("ui.*") into the concrete tools they cover. */
const expand = (patterns: string[], tools: ToolInfo[]) => tools.filter((t) => patterns.some((p) => matchesPattern(p, t.name))).map((t) => t.name);

/** Collapse back: a fully selected multi-tool family becomes "family.*". */
function compress(selected: string[], tools: ToolInfo[]): string[] {
  const out: string[] = [];
  for (const fam of [...new Set(tools.map((t) => familyOf(t.name)))]) {
    const members = tools.filter((t) => familyOf(t.name) === fam).map((t) => t.name);
    const picked = members.filter((m) => selected.includes(m));
    if (members.length > 1 && picked.length === members.length) out.push(`${fam}.*`);
    else out.push(...picked);
  }
  return out;
}

export function AgentEditorPage({ mode }: { mode: "new" | "edit" | "copy" }) {
  const { name } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const meta = useMeta();
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => get<AgentDefinition[]>("/api/agents") });
  const prov = useQuery({ queryKey: ["providers"], queryFn: () => get<ProvidersView>("/api/providers") });
  const tools = useMemo(() => (meta.data?.tools ?? []).filter((t) => t.agentVisible), [meta.data]);
  const [issues, setIssues] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [showJson, setShowJson] = useState(false);
  const [previewMood, setPreviewMood] = useState<Mood>("idle");

  const source = mode === "new" ? BLANK : agents.data?.find((a) => a.name === name);
  const form = useForm<FormValues>();
  const { register, watch, setValue, reset, handleSubmit, formState } = form;

  // Fill the form once the definition and tool list are loaded.
  useEffect(() => {
    if (!source || !tools.length) return;
    reset({
      name: mode === "copy" ? `${source.name}-copy` : source.name,
      description: source.description,
      system: source.system,
      connection: ownConnection(source),
      modelId: source.model.id,
      effort: source.model.effort ?? "",
      maxTokensPerTurn: source.model.maxTokensPerTurn,
      maxSteps: source.budget.maxSteps,
      maxOutputTokens: source.budget.maxOutputTokens,
      maxSeconds: source.budget.maxSeconds,
      tools: expand(source.tools, tools),
      alwaysAsk: expand(source.approval.alwaysAsk, tools),
      canDelegateTo: source.canDelegateTo,
      askDelegate: source.approval.alwaysAsk.includes(DELEGATE_TOOL),
      readOnlyFreely: source.approval.askAbove === "read_only",
      avatar: source.avatar ?? defaultLook(source.name || "new-agent"),
    });
    setModels(modelCache.get(ownConnection(source)) ?? []);
  }, [source, tools, mode, reset]);

  const conn = prov.data?.connections.find((c) => c.id === watch("connection"));
  const selected = watch("tools") ?? [];
  const asks = watch("alwaysAsk") ?? [];
  const delegates = watch("canDelegateTo") ?? [];
  const toggle = (field: "tools" | "alwaysAsk", list: string[], tool: string, on: boolean) =>
    setValue(field, on ? [...new Set([...list, tool])] : list.filter((t) => t !== tool), { shouldDirty: true });

  function build(v: FormValues): unknown {
    const c = prov.data!.connections.find((x) => x.id === v.connection)!;
    return {
      name: v.name.trim(),
      description: v.description.trim(),
      system: v.system.trim(),
      tools: compress(v.tools, tools),
      model: {
        provider: c.kind,
        connection: c.id,
        id: v.modelId.trim() || c.defaultModel,
        ...(c.kind !== "anthropic" && c.baseUrl && { baseUrl: c.baseUrl }),
        ...(c.keyEnv && c.kind === "openai-compatible" && { apiKeyEnv: c.keyEnv }),
        ...(v.effort && { effort: v.effort }),
        maxTokensPerTurn: Number(v.maxTokensPerTurn),
      },
      budget: { maxSteps: Number(v.maxSteps), maxOutputTokens: Number(v.maxOutputTokens), maxSeconds: Number(v.maxSeconds) },
      ...(v.avatar && { avatar: v.avatar }),
      canDelegateTo: v.canDelegateTo ?? [],
      approval: {
        alwaysAsk: [...compress(v.alwaysAsk, tools), ...(v.askDelegate ? [DELEGATE_TOOL] : [])],
        ...(v.readOnlyFreely && { askAbove: "read_only" }),
      },
    };
  }

  const onSubmit = handleSubmit(async (v) => {
    // Same schema the core uses, so the UI and CLI agree on what's valid.
    const parsed = AgentDefinition.safeParse(build(v));
    if (!parsed.success) return setIssues(parsed.error.issues.map((i) => `${i.path.join(".") || "agent"}: ${i.message}`));
    if (mode !== "edit" && agents.data?.some((a) => a.name === parsed.data.name)) return setIssues([`An agent named ${parsed.data.name} already exists`]);
    setIssues([]);
    try {
      await api("PUT", `/api/agents/${encodeURIComponent(parsed.data.name)}`, parsed.data);
      await qc.invalidateQueries({ queryKey: ["agents"] });
      toast(`Saved ${parsed.data.name}`);
      nav("/agents");
    } catch (e) {
      setIssues([(e as Error).message]);
    }
  });

  if (mode !== "new" && agents.isSuccess && !source) return <Card>No agent named {name}.</Card>;
  if (!source || !tools.length || !prov.data) return null;

  const families = [...new Set(tools.map((t) => familyOf(t.name)))];
  const thisName = mode === "edit" ? name : undefined;
  const others = (agents.data ?? []).filter((a) => a.name !== thisName && a.name !== watch("name")?.trim());

  return (
    <form onSubmit={onSubmit}>
      <PageHeader
        title={mode === "new" ? "New agent" : mode === "copy" ? `Duplicate ${name}` : `Edit ${name}`}
        sub="Approval for irreversible actions and the untrusted-content rules are added to every agent automatically."
      />
      <Card className="space-y-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Name" hint="lowercase letters, digits and dashes">
            <Input {...register("name")} disabled={mode === "edit"} placeholder="security-auditor" />
          </Field>
          <Field label="Description">
            <Input {...register("description")} placeholder="What is this agent for?" />
          </Field>
        </div>
        <Field label="Role / instructions">
          <Textarea
            {...register("system")}
            className="min-h-28"
            placeholder="e.g. You are a cybersecurity analyst. Audit this Mac's open ports and running services and report risks. Never change settings."
          />
        </Field>

        {watch("avatar") && (
          <section>
            <CardTitle className="mb-3">Avatar</CardTitle>
            <div className="flex flex-wrap items-start gap-6">
              <div className="flex flex-col items-center gap-2">
                <div className="rounded-xl border bg-muted/50 px-4 pt-2">
                  <Avatar look={watch("avatar")} mood={previewMood} size={130} />
                </div>
                <div className="flex max-w-56 flex-wrap justify-center gap-1">
                  {MOOD_LIST.map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`cursor-pointer rounded-full border px-2 py-0.5 text-[11px] ${m === previewMood ? "border-primary bg-accent text-accent-foreground" : "text-muted-foreground"}`}
                      onClick={() => setPreviewMood(m)}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid min-w-64 flex-1 grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Skin tone">
                  <div className="flex gap-1.5">
                    {SKIN_TONES.map((s) => (
                      <button
                        key={s}
                        type="button"
                        title={s}
                        aria-label={s}
                        onClick={() => setValue("avatar.skin", s, { shouldDirty: true })}
                        className={`size-7 cursor-pointer rounded-full border-2 ${watch("avatar.skin") === s ? "border-primary" : "border-transparent"}`}
                        style={{ background: SKIN[s].base }}
                      />
                    ))}
                  </div>
                </Field>
                <Field label="Hair">
                  <div className="flex gap-2">
                    <NativeSelect {...register("avatar.hair")}>
                      {HAIR_STYLES.map((h) => (
                        <option key={h}>{h}</option>
                      ))}
                    </NativeSelect>
                    <Input type="color" {...register("avatar.hairColor")} className="w-12 p-1" title="hair colour" />
                  </div>
                </Field>
                <Field label="Outfit">
                  <div className="flex gap-2">
                    <NativeSelect {...register("avatar.outfit")}>
                      {OUTFITS.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </NativeSelect>
                    <Input type="color" {...register("avatar.shirt")} className="w-12 p-1" title="outfit colour" />
                  </div>
                </Field>
                <Field label="Back gear">
                  <NativeSelect {...register("avatar.back")}>
                    {BACK_ITEMS.map((b) => (
                      <option key={b}>{b}</option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field label="Glow colour" hint="Trims, visor, and the magic dust when it appears or vanishes">
                  <Input type="color" {...register("avatar.accent")} className="w-12 p-1" />
                </Field>
                <Field label="Headgear">
                  <NativeSelect {...register("avatar.accessory")}>
                    {ACCESSORIES.map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </NativeSelect>
                </Field>
                <div className="flex gap-2 sm:col-span-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setValue("avatar", defaultLook(`${watch("name")}-${Math.random()}`), { shouldDirty: true })}
                  >
                    <Shuffle /> Surprise me
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    title="Shows this avatar on your desktop for a few seconds, cycling through its expressions"
                    onClick={async () => {
                      try {
                        await api("POST", "/api/presence/preview", { agent: watch("name")?.trim() || "new-agent", look: watch("avatar") });
                        toast("Look at the bottom-right of your screen");
                      } catch (e) {
                        toast((e as Error).message, true);
                      }
                    }}
                  >
                    <MonitorUp /> Preview on desktop
                  </Button>
                </div>
              </div>
            </div>
          </section>
        )}

        <section>
          <CardTitle className="mb-3">Model</CardTitle>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Field label="Provider">
              <NativeSelect
                {...register("connection", {
                  onChange: (e) => {
                    const c = prov.data!.connections.find((x) => x.id === e.target.value);
                    setModels(modelCache.get(e.target.value) ?? []);
                    if (c?.defaultModel) setValue("modelId", c.defaultModel);
                  },
                })}
              >
                {prov.data.connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                    {c.keySet ? "" : " (no key)"}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Model">
              <div className="flex gap-2">
                <Input {...register("modelId")} list="editor-models" placeholder={conn?.defaultModel || "model id"} />
                <Button
                  type="button"
                  variant="outline"
                  onClick={async () => {
                    const r = await loadModels(watch("connection"));
                    if (r.ok) {
                      setModels(r.models);
                      toast(`${r.models.length} models available`);
                    } else toast(r.error, true);
                  }}
                >
                  <RefreshCw /> Load
                </Button>
              </div>
              <datalist id="editor-models">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
            <Field label="Effort" hint="reasoning depth, where the model supports it">
              <NativeSelect {...register("effort")}>
                <option value="">provider default</option>
                {["low", "medium", "high", "xhigh", "max"].map((e) => (
                  <option key={e}>{e}</option>
                ))}
              </NativeSelect>
            </Field>
          </div>
        </section>

        <section>
          <CardTitle className="mb-3">Limits</CardTitle>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Field label="Max steps">
              <Input type="number" {...register("maxSteps")} min={1} max={500} />
            </Field>
            <Field label="Max output tokens" hint="whole run">
              <Input type="number" {...register("maxOutputTokens")} min={1000} />
            </Field>
            <Field label="Max seconds">
              <Input type="number" {...register("maxSeconds")} min={10} />
            </Field>
            <Field label="Max tokens per turn">
              <Input type="number" {...register("maxTokensPerTurn")} min={1024} max={128000} />
            </Field>
          </div>
        </section>

        <section>
          <CardTitle>Tools</CardTitle>
          <p className="mt-1 mb-3 text-xs text-muted-foreground">
            Tick what this agent may use. <b>Ask</b> = needs your approval every time, even for reversible actions. Irreversible actions always ask.
          </p>
          <label className="mb-3 flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox checked={!!watch("readOnlyFreely")} onCheckedChange={(v) => setValue("readOnlyFreely", !!v, { shouldDirty: true })} />
            Only read-only actions run without asking (ask me before anything that changes something)
          </label>
          <div className="space-y-4">
            {families.map((fam) => {
              const members = tools.filter((t) => familyOf(t.name) === fam);
              const all = members.every((t) => selected.includes(t.name));
              return (
                <div key={fam}>
                  {members.length > 1 && (
                    <label className="mb-1.5 flex cursor-pointer items-center gap-2 text-sm font-semibold">
                      <Checkbox
                        checked={all}
                        onCheckedChange={(v) =>
                          setValue("tools", v ? [...new Set([...selected, ...members.map((t) => t.name)])] : selected.filter((t) => familyOf(t) !== fam), { shouldDirty: true })
                        }
                      />
                      {fam} (all)
                    </label>
                  )}
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-x-6 gap-y-1">
                    {members.map((t) => (
                      <div key={t.name} className="flex items-center gap-2 py-0.5 text-sm" title={t.description}>
                        <Checkbox checked={selected.includes(t.name)} onCheckedChange={(v) => toggle("tools", selected, t.name, !!v)} />
                        <span className="font-mono text-[13px] font-semibold">{t.name}</span>
                        <StatusBadge value={t.baseRisk} />
                        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                          <Checkbox checked={asks.includes(t.name)} onCheckedChange={(v) => toggle("alwaysAsk", asks, t.name, !!v)} />
                          ask
                        </label>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section>
          <CardTitle>Can hand work to</CardTitle>
          <p className="mt-1 mb-3 text-xs text-muted-foreground">
            Agents this one may pass sub-tasks to on its own. They use their own tools and model, and their actions still need your approval as usual. You can also allow
            others for a single run by writing <code className="font-mono">@agent-name</code> in the task.
          </p>
          <label className="mb-2 flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              checked={delegates.includes("*")}
              onCheckedChange={(v) => setValue("canDelegateTo", v ? ["*"] : [], { shouldDirty: true })}
            />
            <b>Any agent</b>
            <span className="text-xs text-muted-foreground">(for coordinators like the orchestrator; includes agents you add later)</span>
          </label>
          {delegates.includes("*") ? null : others.length === 0 ? (
            <p className="text-sm text-muted-foreground">No other agents yet.</p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-x-6 gap-y-1">
              {others.map((a) => (
                <label key={a.name} className="flex cursor-pointer items-center gap-2 py-0.5 text-sm" title={a.description}>
                  <Checkbox
                    checked={delegates.includes(a.name)}
                    onCheckedChange={(v) => setValue("canDelegateTo", v ? [...new Set([...delegates, a.name])] : delegates.filter((n) => n !== a.name), { shouldDirty: true })}
                  />
                  <span className="font-mono text-[13px] font-semibold">{a.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{a.description}</span>
                </label>
              ))}
            </div>
          )}
          <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox checked={!!watch("askDelegate")} onCheckedChange={(v) => setValue("askDelegate", !!v, { shouldDirty: true })} />
            Ask me before each hand-off
          </label>
        </section>

        {issues.length > 0 && (
          <div className="rounded-md border border-bad/40 bg-bad-soft p-3 text-sm text-bad">
            {issues.map((i) => (
              <div key={i}>{i}</div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={formState.isSubmitting}>
            <Save /> {mode === "edit" ? "Save" : "Create agent"}
          </Button>
          <Button variant="outline" asChild>
            <Link to="/agents">Cancel</Link>
          </Button>
          <Button type="button" variant="ghost" className="ml-auto" onClick={() => setShowJson(!showJson)}>
            {showJson ? "Hide JSON" : "Show JSON"}
          </Button>
        </div>
        {showJson && <pre className="overflow-auto rounded-md border bg-muted p-3 font-mono text-xs">{JSON.stringify(build(watch()), null, 2)}</pre>}
      </Card>
    </form>
  );
}
