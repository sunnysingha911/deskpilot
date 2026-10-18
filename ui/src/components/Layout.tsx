import { useQuery } from "@tanstack/react-query";
import { Bot, History, Play, Plug, ScrollText } from "lucide-react";
import { useEffect } from "react";
import { Link, NavLink, Outlet } from "react-router";
import { get } from "@/lib/api";
import type { Meta } from "@/lib/types";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/run", label: "Run a task", icon: Play },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/runs", label: "Runs", icon: History },
  { to: "/providers", label: "Providers", icon: Plug },
  { to: "/activity", label: "Activity log", icon: ScrollText },
];

export function useMeta() {
  return useQuery({ queryKey: ["meta"], queryFn: () => get<Meta>("/api/meta"), refetchInterval: 2000 });
}

export function Layout() {
  const meta = useMeta();
  return (
    <div className="grid h-screen grid-cols-[220px_1fr]">
      <aside className="flex flex-col border-r bg-card px-3 py-4">
        <div className="mb-5 flex items-center gap-2 px-2 text-base font-bold">
          <img src="./icon.svg" alt="" className="size-5" /> deskpilot
        </div>
        <nav className="flex flex-col gap-0.5">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn("flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm hover:bg-muted", isActive && "bg-accent font-semibold text-accent-foreground hover:bg-accent")
              }
            >
              <Icon className="size-4" /> {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto px-2 text-xs text-muted-foreground">
          {meta.error ? (
            <span className="text-bad">{(meta.error as Error).message === "missing or wrong token" ? "Reopen with npm run gui" : "Core server unreachable"}</span>
          ) : meta.data ? (
            <>
              <div>OS: {meta.data.os}</div>
              <RunningSummary runs={meta.data.activeRuns ?? []} />
            </>
          ) : null}
        </div>
      </aside>
      <main className="overflow-auto px-8 pt-6 pb-12">
        <Outlet />
      </main>
    </div>
  );
}

/** "3 running", plus a warning for tasks waiting for approval (each links to its run). */
function RunningSummary({ runs }: { runs: Meta["activeRuns"] }) {
  const waiting = runs.filter((r) => r.pendingApprovals > 0);
  useEffect(() => {
    document.title = waiting.length ? `⚠️ ${waiting.length === 1 ? "Approval" : `${waiting.length} approvals`} needed · deskpilot` : runs.length ? `${runs.length} running · deskpilot` : "deskpilot";
  }, [waiting.length, runs.length]);
  if (!runs.length) return <div>idle</div>;
  return (
    <div className="flex flex-col gap-0.5">
      <Link className="text-warn hover:underline" to="/run">
        ● {runs.length} running
      </Link>
      {waiting.map((r) => (
        <Link key={r.runId} className="font-medium text-bad hover:underline" to={`/runs/${r.runId}`}>
          ⚠ {r.agent} needs your OK
        </Link>
      ))}
    </div>
  );
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-5 flex items-start gap-4">
      <div className="flex-1">
        <h1 className="text-xl font-semibold">{title}</h1>
        {sub && <p className="mt-1 text-muted-foreground">{sub}</p>}
      </div>
      {actions}
    </div>
  );
}
