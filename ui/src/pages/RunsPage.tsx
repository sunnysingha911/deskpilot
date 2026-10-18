import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { PageHeader } from "@/components/Layout";
import { StatusBadge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { get } from "@/lib/api";
import { fmtNum, fmtTime } from "@/lib/format";
import type { RunRow } from "@/lib/types";

export function RunsPage() {
  const nav = useNavigate();
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => get<RunRow[]>("/api/runs"), refetchInterval: 5000 });
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
            {runs.data.map((r) => (
              <Tr key={r.id} className="cursor-pointer hover:[&>td]:bg-muted" onClick={() => nav(`/runs/${r.id}`)}>
                <Td className="whitespace-nowrap">{fmtTime(r.started_at)}</Td>
                <Td>{r.agent}</Td>
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
