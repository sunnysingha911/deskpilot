// Dropping stale observations from the conversation. Screen trees, page snapshots and screenshots
// describe a state that is gone once a newer one exists, yet each one is re-sent on every later
// request. Approach from OpenCode's pruning (also in pi-context-pruning): replace old outputs with a
// short marker, keep the most recent ones, and only prune in batches big enough to be worth breaking
// the prompt cache. Anthropic does this server-side (context editing); the other adapters call
// pruneStale on their own history before each request.
//
// This is the one exception to append-only history: only the content of these observation results
// is replaced, never the model's turns, tool calls or other results.

export interface PrunePolicy {
  /** Internal tool names whose results describe a passing state of the screen or page. */
  tools: string[];
  /** Always keep this many of the most recent tool results (of any tool). */
  keepLastResults: number;
  /** Prune only when at least this many tokens can be removed at once. */
  minTokens: number;
}

export const OBSERVATION_TOOLS = ["browser.snapshot", "ui.dump_tree", "ui.find", "screenshot"];
export const DEFAULT_PRUNE: PrunePolicy = { tools: OBSERVATION_TOOLS, keepLastResults: 2, minTokens: 8000 };

export const PRUNED_PREFIX = "[earlier ";

/** Rough token count (≈4 characters per token for English, JSON and accessibility text). */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

export function prunedMarker(tool: string, tokens: number): string {
  return `${PRUNED_PREFIX}${tool} output removed to save space (~${tokens} tokens); it showed an older state. Call ${tool} again if you need the current one.]`;
}

/** A tool result in an adapter's native history. */
export interface ResultSlot {
  /** Internal tool name. */
  tool: string;
  content: string;
  set(content: string): void;
}

/**
 * Replace stale observation results (all but the newest of each observation tool, and never the last
 * `keepLastResults` results) with a marker, if together they're worth at least `minTokens`.
 * Returns how many tokens this call removed.
 */
export function pruneStale(results: ResultSlot[], policy: PrunePolicy): { results: number; tokens: number } {
  const protectedIdx = new Set<number>();
  for (let i = Math.max(0, results.length - policy.keepLastResults); i < results.length; i++) protectedIdx.add(i);
  const seen = new Set<string>();
  for (let i = results.length - 1; i >= 0; i--) {
    const t = results[i]!.tool;
    if (policy.tools.includes(t) && !seen.has(t)) {
      seen.add(t);
      protectedIdx.add(i);
    }
  }
  const prunable = results
    .map((r, i) => ({ r, i }))
    .filter(
      ({ r, i }) =>
        !protectedIdx.has(i) &&
        policy.tools.includes(r.tool) &&
        !r.content.startsWith(PRUNED_PREFIX) &&
        // Errors and blocked actions are short and explain what went wrong: keep them.
        !r.content.startsWith("ERROR") &&
        !r.content.startsWith("BLOCKED"),
    );
  const tokens = prunable.reduce((n, { r }) => n + estimateTokens(r.content), 0);
  if (!prunable.length || tokens < policy.minTokens) return { results: 0, tokens: 0 };
  for (const { r } of prunable) {
    const marker = prunedMarker(r.tool, estimateTokens(r.content));
    r.set(marker);
    r.content = marker;
  }
  return { results: prunable.length, tokens };
}

/** Tokens currently held out of the history by markers (the size each marker stands for). */
export function prunedTokens(results: ResultSlot[]): number {
  let n = 0;
  for (const r of results) {
    if (!r.content.startsWith(PRUNED_PREFIX)) continue;
    const m = r.content.match(/\(~(\d+) tokens\)/);
    if (m) n += Number(m[1]);
  }
  return n;
}
