// Talk to an agent: while it runs, a message reaches it after its current step; after it's done, a
// reply continues the same conversation as a follow-up run.
import { MessageSquare, Send } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

export function ChatBox({ runId, agent, running, onFollowUp }: { runId: string; agent?: string; running: boolean; onFollowUp: (newRunId: string) => void }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const r = await api<{ queued?: boolean; followUpRunId?: string }>("POST", `/api/runs/${runId}/messages`, { text: t });
      setText("");
      if (r.followUpRunId) onFollowUp(r.followUpRunId);
      else toast("Sent. The agent reads it after its current step.");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const who = agent ?? "the agent";
  return (
    <div className="mt-3 rounded-lg border bg-card p-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
        <MessageSquare className="size-3.5" />
        {running ? `Message ${who} while it works` : `Reply to ${who} to continue this conversation`}
      </div>
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder={running ? "e.g. “skip the second site” or “use Python instead” (Enter to send, Shift+Enter for a new line)" : "e.g. “now make it a table” (Enter to send)"}
          className="min-h-10 flex-1 resize-y rounded-md border bg-background px-2.5 py-2 text-sm"
          aria-label={running ? `Message ${who}` : `Reply to ${who}`}
        />
        <Button onClick={() => void send()} disabled={busy || !text.trim()}>
          <Send /> {running ? "Send" : "Reply"}
        </Button>
      </div>
    </div>
  );
}
