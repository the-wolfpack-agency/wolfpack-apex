/**
 * analytics-guard: the InstinctEventType union is the single source of truth for
 * event names (see .ai/conventions.md). This guard reads analytics.ts and pins
 * two invariants that are easy to break in a large hand-maintained union:
 *
 *   1. No duplicate event literal — a copy/paste that registers the same event
 *      twice silently passes tsc but corrupts the "is this event registered?"
 *      mental model and any code that enumerates the union.
 *   2. The events a new feature relies on are actually registered — here, the
 *      demo-login canary's `canary.demo_run` + `canary.demo_failed`.
 *
 * It is a pure source-text scan (no DB, no imports of the union at runtime), so
 * it costs nothing and runs in CI alongside the other coverage guards.
 */

import { readFileSync } from "fs";
import { join } from "path";

const ANALYTICS_SRC = readFileSync(
  join(process.cwd(), "src/lib/analytics.ts"),
  "utf8",
);

/** Extract every `| "<event>"` union literal from the InstinctEventType union. */
function eventLiterals(src: string): string[] {
  const out: string[] = [];
  const re = /^\s*\|\s*"([a-zA-Z0-9_.]+)"\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

describe("analytics InstinctEventType guard", () => {
  const events = eventLiterals(ANALYTICS_SRC);

  it("has a non-trivial number of registered events", () => {
    expect(events.length).toBeGreaterThan(100);
  });

  // Two literals are duplicated in the historical union (harmless to tsc, real
  // DRY debt). They predate this guard; we baseline them so the guard fails on
  // any NEW duplicate without forcing an unrelated cleanup of the shared union.
  const KNOWN_DUPLICATE_BASELINE = new Set([
    "hr.document_deleted",
    "system.login_rate_limited",
  ]);

  it("introduces no NEW duplicate event literal", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const e of events) {
      if (seen.has(e)) dupes.push(e);
      seen.add(e);
    }
    const newDupes = dupes.filter((e) => !KNOWN_DUPLICATE_BASELINE.has(e));
    expect(newDupes).toEqual([]);
  });

  it("registers the demo-login canary events", () => {
    expect(events).toContain("canary.demo_run");
    expect(events).toContain("canary.demo_failed");
  });
});
