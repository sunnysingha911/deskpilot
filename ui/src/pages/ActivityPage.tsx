import { useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { Link } from "react-router";
import { PageHeader, useMeta } from "@/components/Layout";
import { StatusBadge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/input";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { get } from "@/lib/api";
import { fmtTime, pretty } from "@/lib/format";
import type { ActionRow } from "@/lib/types";

export function ActivityPage() {
  const meta = useMeta();
  const [tool, setTool] = useState("");
  const [risk, setRisk] = useState("");
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const q = new URLSearchParams({ limit: "300", ...(tool && { tool }), ...(risk && { risk }), ...(status && { status }) });
  const rows = useQuery({ queryKey: ["actions", tool, risk, status], queryFn: () => get<ActionRow[]>(`/api/actions?${q}`), refetchInterval: 5000 });

  return (
    <>
      <PageHeader title="Activity log" sub="Every tool call, made by hand, by scripts or by agents. Click a row for details." />
      <div className="mb-3 flex gap-2">
        <NativeSelect className="w-56" value={tool} onChange={(e) => setTool(e.target.value)}>
          <option value="">all tools</option>
          {meta.data?.tools.map((t) => (
            <option key={t.name}>{t.name}</option>
          ))}
        </NativeSelect>
        <NativeSelect className="w-44" value={risk} onChange={(e) => setRisk(e.target.value)}>
          <option value="">any risk</option>
          {["read_only", "reversible", "irreversible"].map((r) => (
            <option key={r}>{r}</option>
          ))}
        </NativeSelect>
        <NativeSelect className="w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">any status</option>
          {["ok", "error", "blocked"].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </NativeSelect>
      </div>
      {rows.data?.length === 0 && <Card className="py-10 text-center text-muted-foreground">No matching actions.</Card>}
      {!!rows.data?.length && (
        <Table>
          <thead>
            <Tr>
              {["#", "Time", "Caller", "Tool", "Risk", "Status", "ms", "Input"].map((h) => (
                <Th key={h}>{h}</Th>
              ))}
            </Tr>
          </thead>
          <tbody>
            {rows.data.map((a) => (
              <Fragment key={a.id}>
                <Tr className="cursor-pointer hover:[&>td]:bg-muted" onClick={() => setOpen(open === a.id ? null : a.id)}>
                  <Td>{a.id}</Td>
                  <Td className="whitespace-nowrap">{fmtTime(a.ts)}</Td>
                  <Td>
                    {a.session_id.startsWith("run-") ? (
                      <Link className="text-primary hover:underline" to={`/runs/${a.session_id}`} onClick={(e) => e.stopPropagation()}>
                        {a.caller}
                      </Link>
                    ) : (
                      a.caller
                    )}
                  </Td>
                  <Td className="font-mono text-xs font-semibold">{a.tool}</Td>
                  <Td>
                    <StatusBadge value={a.risk} />
                  </Td>
                  <Td>
                    <StatusBadge value={a.status} />
                  </Td>
                  <Td>{a.duration_ms}</Td>
                  <Td className="max-w-sm truncate font-mono text-xs">{a.input_json}</Td>
                </Tr>
                {open === a.id && (
                  <Tr>
                    <Td colSpan={8} className="bg-muted/40">
                      {[
                        ["Input", a.input_json],
                        ["Error", a.error],
                        ["Output", a.output_json],
                      ]
                        .filter(([, v]) => v)
                        .map(([label, v]) => (
                          <div key={label} className="mb-2">
                            <div className="text-xs font-semibold text-muted-foreground">{label}</div>
                            <pre className="mt-1 max-h-72 overflow-auto rounded-md border bg-card p-2 font-mono text-xs whitespace-pre-wrap">{pretty(v)}</pre>
                          </div>
                        ))}
                    </Td>
                  </Tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
