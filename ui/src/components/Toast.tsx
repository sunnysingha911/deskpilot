import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type Toast = { id: number; text: string; error: boolean };
const Ctx = createContext<(text: string, error?: boolean) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 7000 : 3000);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="fixed right-5 bottom-5 z-50 flex max-w-md flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={cn("rounded-md px-3.5 py-2.5 text-sm shadow-lg", t.error ? "bg-bad text-white" : "bg-foreground text-background")}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
