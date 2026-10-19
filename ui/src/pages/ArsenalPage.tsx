// A.R.S.E.N.A.L: what it has learned, what it suggests, what it changed (with undo), and its settings.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Mic, MessageCircle, RotateCcw, Sparkles, Volume2, X } from "lucide-react";
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
import type { ArsenalChange, ArsenalDecision, ArsenalReport, ArsenalSaid, ArsenalSettings, ArsenalSuggestion, ArsenalVoiceStatus } from "@/lib/types";

const HOTKEY_LABEL: Record<string, string> = { "option+space": "⌥ Option + Space", "control+option+space": "⌃ Control + ⌥ Option + Space", "command+shift+space": "⇧ Shift + ⌘ Command + Space" };
/** Languages with on-device recognition on recent Macs; "" = the system's. */
const SPEECH_LOCALES = [
  ["", "System language"],
  ["en-IN", "English (India)"],
  ["en-US", "English (US)"],
  ["en-GB", "English (UK)"],
  ["hi-IN", "Hindi"],
  ["de-DE", "German"],
  ["fr-FR", "French"],
  ["es-ES", "Spanish"],
];

/** Kokoro voice ids → readable labels: af_heart → "Heart · American, female". */
function kokoroLabel(id: string): string {
  const [pre, name = id] = id.split("_");
  const accent = { a: "American", b: "British" }[pre?.[0] ?? ""] ?? "";
  const who = { f: "female", m: "male" }[pre?.[1] ?? ""] ?? "";
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} · ${[accent, who].filter(Boolean).join(", ")}`;
}

/** What the voice said: written by a local model, shown as plain text. */
export function SaidView({ said }: { said: ArsenalSaid }) {
  return (
    <div className="mt-2 rounded-md border-l-2 border-primary bg-muted/60 px-3 py-2 text-sm">
      <div className="mb-0.5 text-[11px] text-muted-foreground">
        A.R.S.E.N.A.L · written by the AI (local {said.model}, {(said.ms / 1000).toFixed(1)}s)
      </div>
      {said.text}
    </div>
  );
}

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

function TryIt({ color, voiceReady }: { color: string; voiceReady: boolean }) {
  const [task, setTask] = useState("");
  const [d, setD] = useState<ArsenalDecision | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [said, setSaid] = useState<ArsenalSaid | null>(null);
  const [busy, setBusy] = useState<"explain" | "ask" | null>(null);
  const [question, setQuestion] = useState("");
  const talk = async (kind: "explain" | "ask") => {
    setBusy(kind);
    setErr(null);
    setSaid(null);
    try {
      setSaid(kind === "explain" ? await api<ArsenalSaid>("POST", "/api/arsenal/explain", { task, speak: true }) : await api<ArsenalSaid>("POST", "/api/arsenal/ask", { question, speak: true }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
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
      <div className="flex gap-2">
        <Input id="arsenal-ask" value={task} onChange={(e) => (setTask(e.target.value), setSaid(null))} placeholder="e.g. find remote rust jobs in Berlin" />
        {voiceReady && (
          <Button variant="outline" disabled={task.trim().length < 4 || busy !== null} onClick={() => void talk("explain")}>
            <MessageCircle /> {busy === "explain" ? "Thinking…" : "Explain"}
          </Button>
        )}
      </div>
      {d && <DecisionView d={d} color={color} />}
      <CardTitle className="mt-5 mb-2">Ask it something</CardTitle>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (question.trim() && voiceReady) void talk("ask");
        }}
      >
        <Input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={voiceReady ? "e.g. which agent is best at research? how did my last task go?" : "its voice isn't available (see Voice below)"} disabled={!voiceReady} />
        <Button type="submit" variant="outline" disabled={!voiceReady || !question.trim() || busy !== null}>
          {busy === "ask" ? "Thinking…" : "Ask"}
        </Button>
      </form>
      {said && <SaidView said={said} />}
      {err && <p className="mt-2 text-xs text-bad">{err}</p>}
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
  const voice = useQuery({ queryKey: ["arsenal-voice"], queryFn: () => get<ArsenalVoiceStatus>("/api/arsenal/voice"), refetchInterval: 10_000 });
  const sayVoices = useQuery({
    queryKey: ["arsenal-say-voices"],
    queryFn: () => get<{ system: Array<{ name: string; lang: string }>; natural: string[] }>("/api/arsenal/voices"),
    staleTime: 60_000,
  });
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
    onSuccess: (s) => (setDraft(s), toast("Saved"), refresh(), qc.invalidateQueries({ queryKey: ["arsenal-color"] }), qc.invalidateQueries({ queryKey: ["arsenal-voice"] })),
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
        <TryIt color={draft.color} voiceReady={!!voice.data?.ready} />
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
        <CardTitle className="mb-1 flex items-center gap-2">
          <Volume2 className="size-4 text-primary" /> Voice
          {voice.data &&
            (voice.data.ready ? <Badge tone="ok">ready · {voice.data.model}</Badge> : <Badge tone="warn">{voice.data.enabled ? `not available: ${voice.data.reason}` : "off"}</Badge>)}
        </CardTitle>
        <p className="mb-3 text-xs text-muted-foreground">
          It explains its picks, answers questions about what it has learned and recaps finished tasks, using a model on this Mac (Ollama). It only talks: it can't start tasks, change anything or approve actions. Its words are labelled as written by the AI.
        </p>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
          <Field label="Voice" hint="Off: it stays silent; routing and learning work the same">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.voice} onChange={(e) => setDraft({ ...draft, voice: e.target.checked })} className="size-4" />
              Let A.R.S.E.N.A.L talk
            </label>
          </Field>
          <Field label="Local model" hint="An Ollama model on this Mac">
            <NativeSelect value={draft.voiceModel} onChange={(e) => setDraft({ ...draft, voiceModel: e.target.value })}>
              <option value="">Default{voice.data?.model && !draft.voiceModel ? ` (${voice.data.model})` : ""}</option>
              {(voice.data?.models ?? []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Speak aloud" hint={voice.data?.speakAvailable === false ? "Speaking is macOS-only for now" : "Says its answers out loud (macOS voices). Never while the mic is on."}>
            <NativeSelect value={draft.speak} disabled={voice.data?.speakAvailable === false} onChange={(e) => setDraft({ ...draft, speak: e.target.value as ArsenalSettings["speak"] })}>
              <option value="spoken">When you speak to it</option>
              <option value="always">Always (typed questions too)</option>
              <option value="off">Never</option>
            </NativeSelect>
          </Field>
          <Field
            label={`Speaking voice · ${draft.speakRate ? `${draft.speakRate} wpm` : "normal speed"}`}
            hint={voice.data?.naturalVoiceError ? `Natural voice unavailable (using macOS voice): ${voice.data.naturalVoiceError}` : "Natural = Kokoro, a small voice model running on this Mac"}
          >
            <NativeSelect value={draft.speakEngine} onChange={(e) => setDraft({ ...draft, speakEngine: e.target.value as ArsenalSettings["speakEngine"] })} disabled={draft.speak === "off"}>
              <option value="kokoro">Natural (Kokoro, local)</option>
              <option value="system">macOS voice</option>
            </NativeSelect>
            {draft.speakEngine === "kokoro" ? (
              <NativeSelect className="mt-2" value={draft.kokoroVoice} onChange={(e) => setDraft({ ...draft, kokoroVoice: e.target.value })} disabled={draft.speak === "off"}>
                {(sayVoices.data?.natural.length ? sayVoices.data.natural : [draft.kokoroVoice]).map((v) => (
                  <option key={v} value={v}>
                    {kokoroLabel(v)}
                  </option>
                ))}
              </NativeSelect>
            ) : (
              <NativeSelect className="mt-2" value={draft.speakVoice} onChange={(e) => setDraft({ ...draft, speakVoice: e.target.value })} disabled={draft.speak === "off"}>
                <option value="">System voice</option>
                {(sayVoices.data?.system ?? []).map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name} · {v.lang}
                  </option>
                ))}
              </NativeSelect>
            )}
            <input type="range" min={0} max={300} step={10} value={draft.speakRate} disabled={draft.speak === "off"} onChange={(e) => setDraft({ ...draft, speakRate: Number(e.target.value) })} className="mt-2 w-full" aria-label="speaking speed" />
          </Field>
        </div>

        <CardTitle className="mt-6 mb-1 flex items-center gap-2">
          <Mic className="size-4 text-primary" /> Push to talk
          {draft.listen && voice.data && !voice.data.pushToTalk && <Badge tone="warn">needs the desktop avatars (npm run gui)</Badge>}
        </CardTitle>
        <p className="mb-3 text-xs text-muted-foreground">
          Hold the key (or the orb's mic button) and speak. Questions are answered; tasks wait for you to press Start. Speech is recognised on this Mac only and never sent anywhere. Voice can never approve or deny an action. The first time, macOS asks for Microphone and Speech Recognition access (see docs/permissions.md).
        </p>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
          <Field label="Listening">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.listen} onChange={(e) => setDraft({ ...draft, listen: e.target.checked })} className="size-4" />
              Turn on push-to-talk
            </label>
          </Field>
          <Field label="Hold this key" hint="Works in any app while held">
            <NativeSelect value={draft.hotkey} onChange={(e) => setDraft({ ...draft, hotkey: e.target.value })} disabled={!draft.listen}>
              {(voice.data?.hotkeys ?? ["option+space"]).map((h) => (
                <option key={h} value={h}>
                  {HOTKEY_LABEL[h] ?? h}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Language" hint="On-device recognition only">
            <NativeSelect value={draft.speechLocale} onChange={(e) => setDraft({ ...draft, speechLocale: e.target.value })} disabled={!draft.listen}>
              {SPEECH_LOCALES.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => save.mutate(draft)} disabled={save.isPending}>
            Save voice settings
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              void api("POST", "/api/arsenal/speak/test")
                .then(() => toast("Speaking (save first to hear new choices)"))
                .catch((e) => toast((e as Error).message, true))
            }
          >
            <Volume2 /> Test voice
          </Button>
          <Button variant="outline" onClick={() => void api("POST", "/api/arsenal/forget").then(() => toast("Started a fresh conversation"))}>
            Forget the conversation
          </Button>
        </div>
      </Card>

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
