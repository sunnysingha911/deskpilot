// Files attached to a task: a picker + drop target with removable chips (Run page), and a list of
// download links (Run details). Uploads go one at a time to /api/uploads; the first creates the set.
import { File as FileIcon, FileImage, FileText, Loader2, Paperclip, X } from "lucide-react";
import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { api, attachmentUrl, uploadFile } from "@/lib/api";
import { fmtSize } from "@/lib/format";
import type { AttachedFile } from "@/lib/types";
import { cn } from "@/lib/utils";

// Same limits as the core (src/core/attachments.ts), checked here for quick feedback.
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 10;

export interface AttachmentState {
  set: string | null;
  files: AttachedFile[];
}
export const NO_ATTACHMENTS: AttachmentState = { set: null, files: [] };

function iconFor(mime: string) {
  if (mime.startsWith("image/")) return FileImage;
  if (mime.startsWith("text/") || mime === "application/pdf" || mime.includes("word") || mime === "application/json") return FileText;
  return FileIcon;
}

function Chip({ name, size, mime, busy, onRemove, href }: AttachedFile & { busy?: boolean; onRemove?: () => void; href?: string }) {
  const Icon = busy ? Loader2 : iconFor(mime);
  const body = (
    <>
      <Icon className={cn("size-3.5 shrink-0 text-muted-foreground", busy && "animate-spin")} />
      <span className="max-w-56 truncate">{name}</span>
      <span className="text-muted-foreground">{fmtSize(size)}</span>
    </>
  );
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-1 text-xs">
      {href ? (
        <a href={href} download={name} className="inline-flex items-center gap-1.5 hover:underline" title="Download">
          {body}
        </a>
      ) : (
        body
      )}
      {onRemove && !busy && (
        <button type="button" onClick={onRemove} className="cursor-pointer text-muted-foreground hover:text-foreground" title="Remove" aria-label={`Remove ${name}`}>
          <X className="size-3.5" />
        </button>
      )}
    </span>
  );
}

/** Wraps the task box: drop files on it, or use the Attach button. */
export function AttachmentPicker({
  value,
  onChange,
  disabled,
  onError,
  children,
}: {
  value: AttachmentState;
  onChange: (next: AttachmentState) => void;
  disabled?: boolean;
  onError: (message: string) => void;
  children: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<Array<{ name: string; size: number; mime: string }>>([]);
  const [over, setOver] = useState(false);
  // Uploads run in order and each needs the set id from the one before, so keep the latest state here.
  const latest = useRef(value);
  latest.current = value;

  const add = async (list: FileList | File[]) => {
    const files = [...list];
    let state = latest.current;
    for (const f of files) {
      if (state.files.length >= MAX_FILES) {
        onError(`At most ${MAX_FILES} files per task`);
        break;
      }
      if (f.size > MAX_FILE_BYTES) {
        onError(`${f.name} is larger than 25 MB`);
        continue;
      }
      if (f.size === 0) {
        onError(`${f.name} is empty (folders can't be attached; zip them first)`);
        continue;
      }
      const pending = { name: f.name, size: f.size, mime: f.type || "application/octet-stream" };
      setUploading((u) => [...u, pending]);
      try {
        const r = await uploadFile(f, state.set);
        state = { set: r.set, files: [...state.files, r.file] };
        latest.current = state;
        onChange(state);
      } catch (e) {
        onError(`${f.name}: ${(e as Error).message}`);
      } finally {
        setUploading((u) => u.filter((x) => x !== pending));
      }
    }
  };

  const remove = async (name: string) => {
    const s = latest.current;
    if (!s.set) return;
    try {
      await api("DELETE", `/api/uploads/${encodeURIComponent(s.set)}/${encodeURIComponent(name)}`);
      onChange({ ...latest.current, files: latest.current.files.filter((f) => f.name !== name) });
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (!disabled && e.dataTransfer.files.length) void add(e.dataTransfer.files);
  };

  return (
    <div
      onDragOver={(e) => {
        if (disabled || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      className={cn("relative rounded-md", over && "ring-2 ring-primary ring-offset-2 ring-offset-background")}
    >
      {children}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()} disabled={disabled || uploading.length > 0}>
          <Paperclip /> Attach files
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void add(e.target.files);
            e.target.value = "";
          }}
        />
        {value.files.map((f) => (
          <Chip key={f.name} {...f} onRemove={disabled ? undefined : () => void remove(f.name)} />
        ))}
        {uploading.map((f, i) => (
          <Chip key={`up-${i}`} {...f} busy />
        ))}
        {!value.files.length && !uploading.length && <span className="text-xs text-muted-foreground">or drop files here · any type, up to 25 MB each</span>}
      </div>
    </div>
  );
}

/** Read-only list with download links (Run details). */
export function AttachmentList({ runId, files }: { runId: string; files: AttachedFile[] }) {
  if (!files.length) return null;
  return (
    <div className="mt-3 border-t pt-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Paperclip className="size-3.5" /> Attached files
      </div>
      <div className="flex flex-wrap gap-1.5">
        {files.map((f) => (
          <Chip key={f.name} {...f} href={attachmentUrl(runId, f.name)} />
        ))}
      </div>
    </div>
  );
}
