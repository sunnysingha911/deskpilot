import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap", {
  variants: {
    tone: {
      neutral: "bg-muted text-muted-foreground",
      ok: "bg-ok-soft text-ok",
      warn: "bg-warn-soft text-warn",
      bad: "bg-bad-soft text-bad",
      info: "bg-accent text-accent-foreground",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export function Badge({ className, tone, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

const TONES: Record<string, VariantProps<typeof badgeVariants>["tone"]> = {
  read_only: "ok",
  ok: "ok",
  completed: "ok",
  approved: "ok",
  ready: "ok",
  reversible: "warn",
  running: "warn",
  stopped: "warn",
  budget_exhausted: "warn",
  max_tokens: "warn",
  irreversible: "bad",
  error: "bad",
  blocked: "bad",
  refused: "bad",
  denied: "bad",
};

/** Badge colored by a status/risk keyword. */
export function StatusBadge({ value, label }: { value: string; label?: string }) {
  return <Badge tone={TONES[value] ?? "neutral"}>{label ?? value.replace(/_/g, " ")}</Badge>;
}
