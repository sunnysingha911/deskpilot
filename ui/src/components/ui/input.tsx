import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const field = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(field, "h-9", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(field, "min-h-24 resize-y", className)} {...props} />;
}

/** Native select: reliable inside forms and desktop shells; styled to match. */
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn(field, "h-9 pr-8", className)} {...props} />;
}
