// A.R.S.E.N.A.L's short recap of a finished task, by its voice (a local model). On request only.
import { MessageCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { ArsenalSaid } from "@/lib/types";
import { SaidView } from "@/pages/ArsenalPage";

export function Recap({ runId }: { runId: string }) {
  const [said, setSaid] = useState<ArsenalSaid | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const recap = async () => {
    setBusy(true);
    setErr(null);
    try {
      setSaid(await api<ArsenalSaid>("POST", `/api/runs/${runId}/recap`, { speak: true }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="w-full">
      {!said && (
        <Button size="sm" variant="outline" onClick={() => void recap()} disabled={busy}>
          <MessageCircle /> {busy ? "A.R.S.E.N.A.L is thinking…" : "Recap"}
        </Button>
      )}
      {said && <SaidView said={said} />}
      {err && <p className="mt-1 text-xs text-bad">{err}</p>}
    </div>
  );
}
