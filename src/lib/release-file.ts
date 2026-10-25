import type { CreateReleaseInput, ReleaseEntry } from "@/lib/releases";

/**
 * Parse a release file (kept outside this public repo) into createRelease()
 * input. Each entry may carry `sources` (the PRs it summarizes) for the record;
 * it is dropped here because the page does not show it. Throws with a
 * reason on anything malformed, so a bad file never publishes half a release.
 */
export function parseReleaseFile(text: string): CreateReleaseInput {
  const d = JSON.parse(text) as Record<string, unknown>;
  const str = (k: string): string => {
    const v = d[k];
    if (typeof v !== "string" || !v.trim()) throw new Error(`release file: "${k}" is required`);
    return v.trim();
  };
  const version = str("version");
  const title = str("title");
  const released_on = str("released_on");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(released_on)) throw new Error(`release file: released_on must be YYYY-MM-DD`);
  if (!Array.isArray(d.entries) || d.entries.length === 0) throw new Error("release file: entries must be a non-empty array");
  const entries: ReleaseEntry[] = d.entries.map((raw, i) => {
    const e = raw as Record<string, unknown>;
    const field = (k: string, required: boolean): string => {
      const v = e[k];
      if (v == null || v === "") { if (required) throw new Error(`release file: entry ${i} needs "${k}"`); return ""; }
      if (typeof v !== "string") throw new Error(`release file: entry ${i} "${k}" must be text`);
      return v.trim();
    };
    const entry: ReleaseEntry = { title: field("title", true), description: field("description", true), how_to_use: field("how_to_use", false) };
    const area = field("area", false); if (area) entry.area = area;
    const category = field("category", false); if (category) entry.category = category;
    return entry;
  });
  const text_ = JSON.stringify({ title, entries, summary: d.summary });
  if (/[–—]/.test(text_)) throw new Error("release file: no em or en dashes on the releases page");
  return { version, title, summary: typeof d.summary === "string" ? d.summary.trim() : "", released_on, entries, published: true };
}
