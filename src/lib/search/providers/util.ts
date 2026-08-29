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

/**
 * Run `work` over `items` with at most `limit` in flight, preserving input order.
 *
 * WHY THIS EXISTS. The channels provider awaited one Graph call at a time
 * across up to 8 teams and 160 channels. Measured 2026-08-29 in production it
 * ran at a p95 of 22,136ms and a max of 129,458ms against a 6,000ms fan-out
 * budget, so it routinely produced nothing at all: the budget abandoned it and
 * the user was told Teams held no matches.
 *
 * ORDER IS PRESERVED ON PURPOSE. Results are written to their input slot rather
 * than pushed on completion, so two identical searches return identically
 * ordered results. Ranking that shuffles with network timing is not ranking.
 *
 * BOUNDED, NOT UNLIMITED. Firing 160 Graph calls at once trades a slow provider
 * for a throttled one: Graph answers 429 and the retry costs more than the
 * sequencing saved.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await work(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
