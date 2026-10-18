// Talks to the core server. The per-launch token arrives in the window URL (?t=…), is kept in
// sessionStorage, and is sent on every request. A desktop shell can inject it the same way.
const params = new URLSearchParams(location.search);
const fromUrl = params.get("t");
if (fromUrl) {
  sessionStorage.setItem("deskpilot-token", fromUrl);
  params.delete("t");
  const qs = params.toString();
  history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
}
export const TOKEN = sessionStorage.getItem("deskpilot-token") ?? "";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "x-deskpilot-token": TOKEN, ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const get = <T,>(path: string) => api<T>("GET", path);

export function eventsUrl(runId: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/events?t=${encodeURIComponent(TOKEN)}`;
}
