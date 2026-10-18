import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useNavigate } from "react-router";
import { PageHeader } from "@/components/Layout";
import { StatusBadge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { get } from "@/lib/api";
import { fmtNum, fmtTime } from "@/lib/format";
import type { RunRow } from "@/lib/types";

/** Newest first, with each delegated run listed right under the run that called it. */
function nest(runs: RunRow[]): Array<{ r: RunRow; depth: number }> {
  const ids = new Set(runs.map((r) => r.id));
  const kids = new Map<string, RunRow[]>();
  for (const r of runs) {
    if (r.relation === "delegate" && r.parent_run_id && ids.has(r.parent_run_id)) kids.set(r.parent_run_id, [...(kids.get(r.parent_run_id) ?? []), r]);
  }
  const out: Array<{ r: RunRow; depth: number }> = [];
  const add = (r: RunRow, depth: number) => {
    out.push({ r, depth });
    for (const k of (kids.get(r.id) ?? []).reverse()) add(k, depth + 1);
  };
  for (const r of runs) if (!(r.relation === "delegate" && r.parent_run_id && ids.has(r.parent_run_id))) add(r, 0);
  return out;
}

export function RunsPage() {
  const nav = useNavigate();
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => get<RunRow[]>("/api/runs"), refetchInterval: 5000 });
  const rows = useMemo(() => nest(runs.data ?? []), [runs.data]);
  return (
    <>
      <PageHeader title="Runs" sub="Every agent run, newest first. Open one to see its full workflow." />
      {runs.data?.length === 0 && <Card className="py-10 text-center text-muted-foreground">No runs yet.</Card>}
      {!!runs.data?.length && (
        <Table>
          <thead>
            <Tr>
              {["Started", "Agent", "Model", "Status", "Steps", "Tokens in / out", "Task"].map((h) => (
                <Th key={h}>{h}</Th>
              ))}
            </Tr>
          </thead>
          <tbody>
            {rows.map(({ r, depth }) => (
              <Tr key={r.id} className="cursor-pointer hover:[&>td]:bg-muted" onClick={() => nav(`/runs/${r.id}`)}>
                <Td className="whitespace-nowrap">{fmtTime(r.started_at)}</Td>
                <Td className="whitespace-nowrap">
                  <span className={depth ? "text-muted-foreground" : undefined}>
                    {depth > 0 && `${"\u00a0\u00a0".repeat(depth - 1)}↳ `}
                  </span>
                  {r.agent}
                  {r.relation === "handoff" && (
                    <span className="ml-1.5 text-xs text-muted-foreground" title={`continued from ${r.parent_run_id}`}>
                      (continued)
                    </span>
                  )}
                </Td>
                <Td className="font-mono text-xs">{r.model}</Td>
                <Td>
                  <StatusBadge value={r.status} />
                </Td>
                <Td>{r.steps}</Td>
                <Td className="whitespace-nowrap">
                  {fmtNum(r.input_tokens + r.cache_read_tokens)} / {fmtNum(r.output_tokens)}
                </Td>
                <Td className="max-w-md truncate" title={r.task}>
                  {r.task}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
