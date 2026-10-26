/**
 * Guard: client code never POSTs /api/analytics without the Bearer token.
 *
 * /api/analytics attributes every event to the caller and answers 401 without
 * an Authorization header (that stays: it writes user-attributed rows). Two
 * beacons sent none, the badge-poll counter flush in src/lib/coalesced-fetch.ts
 * and the role-mismatch report in src/lib/client-auth.ts, so each one 401'd:
 * the event was lost and a 401 console error appeared on every dashboard page
 * (the post-merge E2E run saw it on /emails).
 *
 * Every client analytics POST goes through either fetchWithRefresh or
 * sendTelemetry (client-auth.ts), which attaches the token and drops the event
 * when there is no session. A raw `fetch("/api/analytics", ...)` anywhere else
 * fails this test.
 */
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");

/** Files allowed to call fetch("/api/analytics") directly, each with the
 *  property that makes it safe, asserted below. */
const ALLOWED: Record<string, RegExp> = {
  // sendTelemetry itself: attaches the bearer and returns early with no token.
  "src/lib/client-auth.ts": /if \(!token\) return false;[\s\S]*Authorization: `Bearer \$\{token\}`/,
  // emitInsight: bundle-safe (also runs server-side), so it cannot import the
  // "use client" helper; it reads the token itself and drops without one.
  "src/lib/insights/emit.ts": /if \(!token\) return;[\s\S]*Authorization: `Bearer \$\{token\}`/,
  // Login: runs immediately after setInstinctSession() wrote the token.
  "src/app/login/page.tsx": /setInstinctSession\([\s\S]*fetch\("\/api\/analytics",\s*\{[\s\S]{0,80}authHeaders\(\)/,
};

const RAW_ANALYTICS_FETCH = /(?<![\w.])(?:fetch|f)\(\s*["'`]\/api\/analytics["'`]/g;

export function rawAnalyticsFetches(source: string): number {
  return (source.match(RAW_ANALYTICS_FETCH) ?? []).length;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.name === "__tests__" || entry.name === "node_modules" || entry.name === "api") continue;
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("analytics beacons always carry the session token", () => {
  it("has no raw fetch('/api/analytics') outside the vetted senders", () => {
    const offenders = walk(path.join(ROOT, "src"))
      .map((f) => path.relative(ROOT, f))
      .filter((rel) => !(rel in ALLOWED))
      .filter((rel) => rawAnalyticsFetches(fs.readFileSync(path.join(ROOT, rel), "utf8")) > 0);
    expect(offenders).toEqual([]);
  });

  it.each(Object.entries(ALLOWED))("%s still attaches the token", (rel, mustMatch) => {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    expect(src).toMatch(mustMatch);
  });

  it("detects the tokenless beacon shape that 401'd", () => {
    expect(
      rawAnalyticsFetches(`
    fetch("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      keepalive: true,
    })`),
    ).toBe(1);
    expect(rawAnalyticsFetches(`void fetchWithRefresh("/api/analytics", { method: "POST" })`)).toBe(0);
    expect(rawAnalyticsFetches(`sendTelemetry("pwa.installed")`)).toBe(0);
  });
});
