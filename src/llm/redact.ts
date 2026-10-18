// Transcripts go into the run log; inline files (base64 images/PDFs) would bloat it, so they're
// replaced by a short marker there. The live conversation sent to the provider is unchanged.

const marker = (s: string) => `[inline file omitted: ${Math.round((s.length * 3) / 4 / 1024)} KB]`;

/**
 * Deep copy of a native transcript with inline file data replaced by a marker. Only the fields the
 * adapters use for files are touched: Anthropic `source.data`, OpenAI `image_url.url` (data: URLs),
 * Ollama `images`.
 */
export function omitInlineData<T>(x: T): T {
  const walk = (v: unknown, key: string): unknown => {
    if (typeof v === "string") {
      if (key === "data" && v.length > 1000) return marker(v);
      if (key === "url" && v.startsWith("data:")) return marker(v);
      return v;
    }
    if (Array.isArray(v)) return key === "images" ? v.map((s) => (typeof s === "string" ? marker(s) : s)) : v.map((e) => walk(e, ""));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, walk(val, k)]));
    return v;
  };
  return walk(x, "") as T;
}
