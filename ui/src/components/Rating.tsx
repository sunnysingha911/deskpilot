// 👍 / 👎 on a finished run: A.R.S.E.N.A.L learns from it.
import { useQueryClient } from "@tanstack/react-query";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useEffect, useState } from "react";
import { useToast } from "@/components/Toast";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export function Rating({ runId, initial }: { runId: string; initial?: 1 | -1 | null }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [value, setValue] = useState<1 | -1 | null>(initial ?? null);
  useEffect(() => setValue(initial ?? null), [initial, runId]);
  const rate = async (v: 1 | -1) => {
    const next = value === v ? null : v;
    try {
      await api("POST", `/api/runs/${runId}/rating`, { rating: next ?? 0 });
      setValue(next);
      qc.invalidateQueries({ queryKey: ["arsenal"] });
      if (next) toast(next === 1 ? "Thanks: A.R.S.E.N.A.L learns from this" : "Noted: A.R.S.E.N.A.L will weigh this down");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const btn = (v: 1 | -1) =>
    cn("cursor-pointer rounded-md border p-1.5 hover:bg-muted", value === v && (v === 1 ? "border-ok bg-ok-soft text-ok" : "border-bad bg-bad-soft text-bad"));
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      How did it do?
      <button type="button" className={btn(1)} onClick={() => void rate(1)} aria-label="Good result" aria-pressed={value === 1}>
        <ThumbsUp className="size-3.5" />
      </button>
      <button type="button" className={btn(-1)} onClick={() => void rate(-1)} aria-label="Bad result" aria-pressed={value === -1}>
        <ThumbsDown className="size-3.5" />
      </button>
    </span>
  );
}
