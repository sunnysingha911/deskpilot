// Text features for A.R.S.E.N.A.L's models: words and word pairs of a task, weighted by TF-IDF,
// compared by cosine similarity. Small, deterministic, no dependencies.

const STOP = new Set(
  "a an the and or but if then else of to in on at by for with from into onto about as is are was were be been being it its this that these those i me my you your we our they them their he she his her do does did done can could should would will shall may might must please just also than so such not no yes what which who whom whose when where why how all any each every some more most other only own same too very s t up out over under again once here there don doesn didn isn aren wasn won can't let get got make use using tell give one".split(
    " ",
  ),
);

/** Lowercase word stems (crude suffix trim) and adjacent pairs, plus a few shape features. */
export function tokenize(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " zzurl ")
    .replace(/(?:~|\/)[\w.\-/]+/g, " zzpath ")
    .split(/[^a-z0-9+#]+/)
    .filter((w) => w.length >= 2 && !STOP.has(w) && !/^\d+$/.test(w))
    .map(stem);
  const out = [...words];
  for (let i = 0; i + 1 < words.length; i++) out.push(`${words[i]}_${words[i + 1]}`);
  return out;
}

const KEEP = new Set(["thing", "anything", "something", "nothing", "everything", "string", "spring", "morning", "evening", "during", "ceiling", "news", "series", "species", "always", "process", "access", "address", "analysis", "status", "canvas", "bias", "alias", "atlas", "this", "has", "was", "is", "its", "us", "bus", "gas", "yes"]);

/** Light plural/-ing/-ed trimming that keeps words readable ("files" → "file", "notes" → "note"). */
function stem(w: string): string {
  if (KEEP.has(w)) return w;
  if (w.length > 6 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  // -es only after s/x/z/ch/sh ("boxes", "matches"); otherwise just -s ("files", "titles", "notes").
  if (w.length > 4 && /(?:s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) return w.slice(0, -1);
  if (w.length > 6 && w.endsWith("ed")) return w.slice(0, -2);
  return w;
}

export type Vec = Map<string, number>;

/** Document frequencies, updated as Arsenal sees tasks. */
export class Idf {
  constructor(
    public docs = 0,
    public df: Record<string, number> = {},
  ) {}

  add(tokens: string[]): void {
    this.docs++;
    for (const t of new Set(tokens)) this.df[t] = (this.df[t] ?? 0) + 1;
  }

  weight(t: string): number {
    return Math.log((this.docs + 1) / ((this.df[t] ?? 0) + 1)) + 1;
  }

  vector(tokens: string[]): Vec {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const v: Vec = new Map();
    let norm = 0;
    for (const [t, n] of tf) {
      const w = (1 + Math.log(n)) * this.weight(t);
      v.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    return v;
  }
}

export function cosine(a: Vec, b: Vec): number {
  let s = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const [t, w] of small) {
    const o = big.get(t);
    if (o) s += w * o;
  }
  return s;
}

/** The terms two vectors share, strongest first (for explanations). */
export function sharedTerms(a: Vec, b: Vec, n = 3): string[] {
  const out: Array<[string, number]> = [];
  for (const [t, w] of a) {
    const o = b.get(t);
    if (o && !t.includes("_") && !t.startsWith("zz")) out.push([t, w * o]);
  }
  return out.sort((x, y) => y[1] - x[1]).slice(0, n).map(([t]) => t);
}
