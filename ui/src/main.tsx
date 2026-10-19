import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createHashRouter, Navigate, RouterProvider } from "react-router";
import { Layout } from "@/components/Layout";
import { ToastProvider } from "@/components/Toast";
import { Card } from "@/components/ui/card";
import { TOKEN } from "@/lib/api";
import { ActivityPage } from "@/pages/ActivityPage";
import { ArsenalPage } from "@/pages/ArsenalPage";
import { AgentEditorPage } from "@/pages/AgentEditorPage";
import { AgentsPage } from "@/pages/AgentsPage";
import { OverlayPage } from "@/pages/OverlayPage";
import { ProvidersPage } from "@/pages/ProvidersPage";
import { RunDetailPage } from "@/pages/RunDetailPage";
import { RunPage } from "@/pages/RunPage";
import { RunsPage } from "@/pages/RunsPage";
import "./index.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } } });

// Hash routing works the same over http://, file:// and Electron/Tauri custom protocols.
const router = createHashRouter([
  // Shown by the desktop overlay window (native/overlay), outside the control panel layout.
  { path: "/overlay", element: <OverlayPage /> },
  {
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/run" replace /> },
      { path: "run", element: <RunPage /> },
      { path: "arsenal", element: <ArsenalPage /> },
      { path: "agents", element: <AgentsPage /> },
      { path: "agents/new", element: <AgentEditorPage mode="new" /> },
      { path: "agents/:name/edit", element: <AgentEditorPage mode="edit" /> },
      { path: "agents/:name/copy", element: <AgentEditorPage mode="copy" /> },
      { path: "runs", element: <RunsPage /> },
      { path: "runs/:id", element: <RunDetailPage /> },
      { path: "providers", element: <ProvidersPage /> },
      { path: "activity", element: <ActivityPage /> },
      { path: "*", element: <Navigate to="/run" replace /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {TOKEN ? (
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryClientProvider>
    ) : (
      <div className="grid h-screen place-items-center">
        <Card className="max-w-md">
          <h1 className="text-lg font-semibold">Not connected</h1>
          <p className="mt-2 text-muted-foreground">Open the control panel with npm run gui so it receives this session's access token.</p>
        </Card>
      </div>
    )}
  </StrictMode>,
);
