import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Square, Wrench } from "lucide-react";
import { Link, useParams } from "react-router";
import { Timeline } from "@/components/Timeline";
import { useToast } from "@/components/Toast";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { useRunEvents } from "@/hooks/useRunEvents";
import { api, get } from "@/lib/api";
import { fmtDuration, fmtNum, fmtTime, pretty } from "@/lib/format";
import type { RunDetail } from "@/lib/types";

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="text-sm">
      <span className="text-muted-foreground">{label} </span>
      <b className="font-semibold">{children}</b>
    </div>
  );
}

export function RunDetailPage() {
  const { id = "" } = useParams();
  const toast = useToast();
  const stream = useRunEvents(id);
  const detail = useQuery({ queryKey: ["run", id], queryFn: () => get<RunDetail>(`/api/runs/${id}`), refetchInterval: stream.done ? false : 3000 });
  const stop = useMutation({ mutationFn: () => api("POST", `/api/runs/${stream.currentRunId ?? id}/stop`), onError: (e) => toast((e as Error).message, true) });
  const d = detail.data;
  if (detail.error) return <Card>{(detail.error as Error).message}</Card>;
  if (!d) return null;
  const r = d.run;
  // Runs recorded before timelines were saved have no events: show their logged tool calls instead.
  const legacy = stream.done && stream.events.length === 0;

  return (
    <>
      <div className="flex items-center">
        <Link to="/runs" className="flex items-center gap-1 text-sm text-primary hover:underline">
          <ArrowLeft className="size-4" /> Runs
        </Link>
        {!stream.done && d.active && (
          <Button variant="destructive" className="ml-auto" onClick={() => stop.mutate()} disabled={stop.isPending}>
            <Square /> Stop
          </Button>
        )}
      </div>
      <h1 className="mt-3 text-xl font-semibold">{r.task}</h1>
      <Card className="mt-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <StatusBadge value={r.status} />
          <Stat label="agent">{r.agent}</Stat>
          <Stat label="model">
            {r.provider} / {r.model}
          </Stat>
          <Stat label="steps">{r.steps}</Stat>
          <Stat label="tokens">
            {fmtNum(r.input_tokens)} in + {fmtNum(r.cache_read_tokens)} cached · {fmtNum(r.output_tokens)} out
          </Stat>
          <Stat label="duration">{fmtDuration(r.started_at, r.ended_at)}</Stat>
          <Stat label="tool calls">{d.actions.length}</Stat>
        </div>
        {r.error && <p className="mt-2 text-xs text-bad">{r.error}</p>}
        <p className="mt-2 text-xs text-muted-foreground">
          {r.id} · started {fmtTime(r.started_at)}
        </p>
      </Card>
      <CardTitle className="mt-6 mb-3">Workflow</CardTitle>
      {legacy ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">This run predates saved timelines; showing its logged tool calls.</p>
          {d.actions.map((a) => (
            <Card key={a.id} className="py-2.5">
              <div className="flex items-center gap-2">
                <Wrench className="size-4 text-muted-foreground" />
                <span className="font-mono text-[13px] font-semibold">{a.tool}</span>
                <StatusBadge value={a.status} />
                <StatusBadge value={a.risk} />
                <span className="text-xs text-muted-foreground">{a.duration_ms}ms</span>
              </div>
              <pre className="mt-2 max-h-60 overflow-auto rounded-md border bg-muted p-2 font-mono text-xs whitespace-pre-wrap">{pretty(a.output_json ?? a.error ?? a.input_json)}</pre>
            </Card>
          ))}
          {r.final_text && <Card className="whitespace-pre-wrap">{r.final_text}</Card>}
        </div>
      ) : (
        <Timeline events={stream.events} />
      )}
    </>
  );
}
