import { useEffect, useRef, useState } from "react";
import { eventsUrl } from "@/lib/api";
import type { RunEvent } from "@/lib/types";

export interface RunStream {
  /** Events across the run and any fallback runs it handed over to, in order. */
  events: Array<RunEvent & { _runId: string; _key: string }>;
  /** Run currently being followed (changes on provider fallback). */
  currentRunId: string | null;
  /** The run has finished (live run closed, or history fully replayed). */
  done: boolean;
}

/** Stream a run's events over SSE: history first, then live. Follows provider fallbacks. */
export function useRunEvents(runId: string | null): RunStream {
  const [state, setState] = useState<RunStream>({ events: [], currentRunId: runId, done: false });
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!runId) return;
    setState({ events: [], currentRunId: runId, done: false });
    let cancelled = false;

    const follow = (id: string) => {
      sourceRef.current?.close();
      const es = new EventSource(eventsUrl(id));
      sourceRef.current = es;
      setState((s) => ({ ...s, currentRunId: id }));
      es.addEventListener("message", (m) => {
        if (cancelled) return;
        const { type, data } = JSON.parse(m.data) as { type: string; data: RunEvent };
        const ev = { ...data, type, _runId: id, _key: `${id}:${m.lastEventId}` };
        setState((s) => (s.events.some((e) => e._key === ev._key) ? s : { ...s, events: [...s.events, ev] }));
        if (type === "fallback" && typeof data.nextRunId === "string") follow(data.nextRunId);
        if (type === "closed") {
          es.close();
          setState((s) => ({ ...s, done: true }));
        }
      });
      es.addEventListener("idle", () => {
        es.close();
        setState((s) => (s.events.some((e) => e.type === "fallback" && e._runId === id) ? s : { ...s, done: true }));
      });
    };
    follow(runId);
    return () => {
      cancelled = true;
      sourceRef.current?.close();
    };
  }, [runId]);

  return state;
}
