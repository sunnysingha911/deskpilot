// Files the user attaches to a task. Each task gets its own folder, data/uploads/<setId>/, holding
// copies of the files (never the user's originals). Names are reduced to a safe basename so nothing
// can point outside the folder. Agents read them through file.read (src/tools/file.ts).
import { randomUUID } from "node:crypto";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import { DATA_DIR } from "./paths.ts";

/** data/uploads; DESKPILOT_UPLOADS_DIR overrides it (tests point it into scratch/). */
export function uploadsDir(): string {
  return process.env.DESKPILOT_UPLOADS_DIR ?? join(DATA_DIR, "uploads");
}
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 10;
export const SET_ID_RE = /^att-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/;

export interface Attachment {
  name: string;
  size: number;
  mime: string;
  /** Absolute path of the copy in the upload folder. */
  path: string;
}

export interface AttachmentSet {
  id: string;
  dir: string;
  files: Attachment[];
}

export class AttachmentError extends Error {
  constructor(
    public code: "bad_set" | "too_large" | "too_many" | "not_found" | "empty",
    message: string,
  ) {
    super(message);
    this.name = "AttachmentError";
  }
}

const MIME: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".html": "text/html",
  ".htm": "text/html",
  ".log": "text/plain",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".svg": "image/svg+xml",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".rtf": "application/rtf",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

export function mimeFor(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
}

/** A file name that is safe to create inside the upload folder: a plain basename, no path tricks. */
export function safeFileName(name: string): string {
  let n = basename(name.replace(/\\/g, "/"))
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"|?*/]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (n.length > 120) {
    const ext = extname(n).slice(0, 16);
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n || "file";
}

export function newSetId(): string {
  return `att-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
}

function setDir(id: string): string {
  if (!SET_ID_RE.test(id)) throw new AttachmentError("bad_set", `invalid attachment set id`);
  return join(uploadsDir(), id);
}

export function createSet(): string {
  const id = newSetId();
  mkdirSync(setDir(id), { recursive: true });
  return id;
}

export function setExists(id: string): boolean {
  return SET_ID_RE.test(id) && existsSync(setDir(id));
}

export function listSet(id: string): AttachmentSet {
  const dir = setDir(id);
  if (!existsSync(dir)) throw new AttachmentError("bad_set", `no such attachment set`);
  const files = readdirSync(dir)
    .filter((n) => !n.startsWith("."))
    .map((name) => {
      const path = join(dir, name);
      const st = statSync(path);
      return st.isFile() ? { name, size: st.size, mime: mimeFor(name), path } : null;
    })
    .filter((f): f is Attachment => f !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { id, dir, files };
}

/** "report.pdf" → "report (2).pdf" if that name is taken. */
function uniqueName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) {
    const n = `${stem} (${i})${ext}`;
    if (!existsSync(join(dir, n))) return n;
  }
}

function checkRoom(set: AttachmentSet): void {
  if (set.files.length >= MAX_FILES) throw new AttachmentError("too_many", `at most ${MAX_FILES} files per task`);
}

const tooLarge = () => new AttachmentError("too_large", `files can be at most ${MAX_FILE_BYTES / 1024 / 1024} MB`);

/** Store an uploaded stream (stops reading past the size limit). */
export async function addStream(id: string, name: string, body: Readable): Promise<Attachment> {
  const set = listSet(id);
  checkRoom(set);
  const final = uniqueName(set.dir, safeFileName(name));
  const part = join(set.dir, `.${randomUUID()}.part`);
  let size = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      cb(size > MAX_FILE_BYTES ? tooLarge() : null, chunk);
    },
  });
  try {
    await pipeline(body, limit, createWriteStream(part, { flags: "wx" }));
  } catch (err) {
    rmSync(part, { force: true });
    throw err;
  }
  if (size === 0) {
    rmSync(part, { force: true });
    throw new AttachmentError("empty", "the file is empty");
  }
  renameSync(part, join(set.dir, final));
  return { name: final, size, mime: mimeFor(final), path: join(set.dir, final) };
}

/** Copy a local file in (CLI --file). The original is only read. */
export function addFromPath(id: string, src: string): Attachment {
  const set = listSet(id);
  checkRoom(set);
  const st = statSync(src);
  if (!st.isFile()) throw new AttachmentError("not_found", `${src} is not a file`);
  if (st.size > MAX_FILE_BYTES) throw tooLarge();
  const final = uniqueName(set.dir, safeFileName(src));
  copyFileSync(src, join(set.dir, final));
  return { name: final, size: st.size, mime: mimeFor(final), path: join(set.dir, final) };
}

/** One attached file by its stored name (exact match only). */
export function getAttachment(id: string, name: string): Attachment {
  const f = listSet(id).files.find((x) => x.name === name);
  if (!f) throw new AttachmentError("not_found", `no attached file named '${name}'`);
  return f;
}

/** Remove one file from a set (before the task starts). */
export function removeAttachment(id: string, name: string): void {
  rmSync(getAttachment(id, name).path);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
