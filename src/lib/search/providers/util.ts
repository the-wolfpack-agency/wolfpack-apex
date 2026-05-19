/**
 * Shared helpers used by every provider — case-insensitive substring
 * matcher (no RegExp, so no regex-DoS risk) and the snippet builder
 * that centers ~140 chars around the first match. Lifted out of
 * runSearch.ts unchanged so all providers see identical semantics.
 */

/** Case-insensitive substring match. Pure `String.includes` — hardened
 *  against regex-DoS. Empty needle returns true (matches everything). */
export function matches(haystack: string, needle: string): boolean {
  if (!needle) return true;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** Trim body text to ~140 chars centered around the first match so the
 *  user sees context, not always the start. Empty query returns the
 *  first 140 chars. */
export function buildSnippet(body: string, q: string): string {
  const text = (body || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (!q) return text.slice(0, 140);
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text.slice(0, 140);
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + 100);
  return (
    (start > 0 ? "..." : "") +
    text.slice(start, end) +
    (end < text.length ? "..." : "")
  );
}
