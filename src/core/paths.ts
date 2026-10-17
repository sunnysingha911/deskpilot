import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SCRATCH_DIR = join(ROOT, "scratch");
export const DATA_DIR = join(ROOT, "data");

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
