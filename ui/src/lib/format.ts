export const fmtNum = (n: number | null | undefined) => Number(n ?? 0).toLocaleString();
export const fmtTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "");

export function fmtDuration(start: string | null | undefined, end?: string | null) {
  if (!start) return "";
  const ms = (end ? new Date(end) : new Date()).getTime() - new Date(start).getTime();
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Pretty-print JSON (or a JSON string); fall back to the raw text. */
export function pretty(v: unknown): string {
  if (typeof v === "string") {
    try {
      return JSON.stringify(JSON.parse(v), null, 2);
    } catch {
      return v;
    }
  }
  return JSON.stringify(v, null, 2);
}

export const familyOf = (tool: string) => (tool.includes(".") ? tool.split(".")[0]! : tool);

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
