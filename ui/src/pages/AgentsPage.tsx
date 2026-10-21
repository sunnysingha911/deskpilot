import { defaultLook } from "@/lib/schema.ts";
import { Avatar } from "@/components/Avatar";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { PageHeader } from "@/components/Layout";
import { useToast } from "@/components/Toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api, get } from "@/lib/api";
import type { AgentDefinition } from "@/lib/types";
import { ownConnection } from "@/pages/RunPage";

function DeleteButton({ name }: { name: string }) {
  const [armed, setArmed] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: () => api("DELETE", `/api/agents/${name}`),
    onSuccess: () => {
      toast(`Deleted ${name} (moved to data/agents-trash)`);
      qc.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: (e) => toast((e as Error).message, true),
  });
  return (
    <Button variant="destructive" size="sm" onClick={() => (armed ? del.mutate() : setArmed(true))} onBlur={() => setArmed(false)} disabled={del.isPending}>
      <Trash2 /> {armed ? "Click again to delete" : "Delete"}
    </Button>
  );
}

export function AgentsPage() {
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => get<AgentDefinition[]>("/api/agents") });
  return (
    <>
      <PageHeader
        title="Agents"
        sub="Each agent is a JSON file in agents/: its role, tools, model and limits."
        actions={
          <Button asChild>
            <Link to="/agents/new">
              <Plus /> New agent
            </Link>
          </Button>
        }
      />
      {agents.data?.length === 0 && <Card className="py-10 text-center text-muted-foreground">No agents yet.</Card>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
        {agents.data?.map((a) => (
          <Card key={a.name} className="flex flex-col">
            <div className="flex items-center gap-2">
              <Avatar look={a.avatar ?? defaultLook(a.name)} size={40} crop="head" className="-my-1 shrink-0" />
              <b>{a.name}</b>
              <Badge tone="info" className="ml-auto">
                {ownConnection(a)}
              </Badge>
            </div>
            <p className="mt-1 text-muted-foreground">{a.description || "—"}</p>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">model</dt>
              <dd className="font-mono">{a.model.id}</dd>
              <dt className="text-muted-foreground">tools</dt>
              <dd className="font-mono">{a.tools.join(", ") || "none"}</dd>
              {a.canDelegateTo.length > 0 && (
                <>
                  <dt className="text-muted-foreground">hands work to</dt>
                  <dd className="font-mono">{a.canDelegateTo.includes("*") ? "any agent" : a.canDelegateTo.join(", ")}</dd>
                </>
              )}
              <dt className="text-muted-foreground">limits</dt>
              <dd>
                {a.budget.maxSteps} steps · {a.budget.maxSeconds}s
              </dd>
              {a.approval.askAbove === "read_only" && (
                <>
                  <dt className="text-muted-foreground">asks for</dt>
                  <dd>anything that isn't read-only</dd>
                </>
              )}
              {a.approval.alwaysAsk.length > 0 && (
                <>
                  <dt className="text-muted-foreground">always asks</dt>
                  <dd className="font-mono">{a.approval.alwaysAsk.join(", ")}</dd>
                </>
              )}
            </dl>
            <div className="mt-auto flex gap-2 pt-4">
              <Button variant="outline" size="sm" asChild>
                <Link to={`/agents/${a.name}/edit`}>
                  <Pencil /> Edit
                </Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link to={`/agents/${a.name}/copy`}>
                  <Copy /> Duplicate
                </Link>
              </Button>
              <div className="flex-1" />
              <DeleteButton name={a.name} />
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
