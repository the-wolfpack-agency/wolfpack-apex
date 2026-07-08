/**
 * Cron-schedule coverage guardrail.
 *
 * A cron route can exist in src/app/api/cron/<name>/route.ts, compile, pass its
 * own contract tests, and STILL never run - because Vercel only fires the paths
 * listed in vercel.json `crons`. That exact gap left the release-gate notifier
 * (and the principles weekly report) silently dead: the code was perfect, but
 * nothing invoked it, so no notification ever reached the bell.
 *
 * This test closes the class: every cron route directory MUST be scheduled in
 * vercel.json, or be explicitly allowlisted here with a reason (e.g. a route
 * that is only ever triggered by an admin button or another job). New orphan =
 * red build, not a months-later "why did I never get notified?".
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

/**
 * Cron routes intentionally NOT on a Vercel schedule. Keep empty unless a route
 * is genuinely manual/triggered-elsewhere; add a one-line reason so the next
 * reader knows it is deliberate, not another forgotten schedule.
 */
const MANUAL_ONLY: Record<string, string> = {
  // (none today - both previously-orphaned routes are now scheduled)
};

const REPO_ROOT = join(__dirname, "..", "..");
const CRON_DIR = join(REPO_ROOT, "src", "app", "api", "cron");

function scheduledCronPaths(): Set<string> {
  const raw = readFileSync(join(REPO_ROOT, "vercel.json"), "utf8");
  const parsed = JSON.parse(raw) as { crons?: Array<{ path: string; schedule: string }> };
  return new Set((parsed.crons ?? []).map((c) => c.path));
}

function cronRouteDirs(): string[] {
  return readdirSync(CRON_DIR).filter((name) => {
    const full = join(CRON_DIR, name);
    if (!statSync(full).isDirectory()) return false;
    // Only count dirs that actually export a route handler.
    try {
      statSync(join(full, "route.ts"));
      return true;
    } catch {
      return false;
    }
  });
}

describe("cron schedule coverage", () => {
  const scheduled = scheduledCronPaths();
  const dirs = cronRouteDirs();

  it("finds cron route directories", () => {
    expect(dirs.length).toBeGreaterThan(0);
  });

  it("has no duplicate cron paths in vercel.json (a duplicate path fails the Vercel build)", () => {
    const raw = readFileSync(join(REPO_ROOT, "vercel.json"), "utf8");
    const crons = (JSON.parse(raw) as { crons?: Array<{ path: string }> }).crons ?? [];
    const paths = crons.map((c) => c.path);
    const duplicates = [...new Set(paths.filter((p, i) => paths.indexOf(p) !== i))];
    expect(duplicates).toEqual([]);
  });

  test.each(cronRouteDirs())(
    "cron route %s is scheduled in vercel.json (or explicitly manual-only)",
    (name) => {
      const path = `/api/cron/${name}`;
      const isScheduled = scheduled.has(path);
      const isManual = name in MANUAL_ONLY;
      expect(isScheduled || isManual).toBe(true);
    },
  );

  it("every scheduled cron path resolves to a real route dir (no stale schedule)", () => {
    const dirSet = new Set(dirs.map((d) => `/api/cron/${d}`));
    const staleCronPaths = [...scheduled].filter(
      // Only validate the /api/cron/* namespace; other scheduled paths
      // (e.g. /api/support/poll) live outside this directory by design.
      (p) => p.startsWith("/api/cron/") && !dirSet.has(p),
    );
    expect(staleCronPaths).toEqual([]);
  });

  it("MANUAL_ONLY has no stale entries (allowlist matches reality)", () => {
    const dirNames = new Set(dirs);
    const staleAllowlist = Object.keys(MANUAL_ONLY).filter((n) => !dirNames.has(n));
    expect(staleAllowlist).toEqual([]);
  });
});
