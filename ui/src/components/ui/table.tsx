import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className={cn("w-full text-sm", className)} {...props} />
    </div>
  );
}
export const Th = ({ className, ...p }: ComponentProps<"th">) => <th className={cn("border-b bg-muted px-3 py-2 text-left text-xs font-semibold text-muted-foreground", className)} {...p} />;
export const Td = ({ className, ...p }: ComponentProps<"td">) => <td className={cn("border-b px-3 py-2 align-top", className)} {...p} />;
export const Tr = ({ className, ...p }: ComponentProps<"tr">) => <tr className={cn("last:[&>td]:border-b-0", className)} {...p} />;
