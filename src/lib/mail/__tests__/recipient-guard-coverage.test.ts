/**
 * recipient-guard-coverage.test.ts
 *
 * Guardrail (same spirit as audit-coverage / capability-coverage): every job
 * that fans out to team-member recipients selected from `instinct_team_members`
 * MUST route through the undeliverable-recipient guard
 * (`@/lib/mail/undeliverable-recipients`). This is the test that would have
 * caught the 2026-07-04 cto@wolfpack.dev bounce class before it shipped.
 *
 * Offline / no DB — pure source scan.
 */

import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "..", "..", "..", "..");

/** Fan-out senders that select real recipients and must apply the guard. */
const GUARDED_FAN_OUT_PATHS = [
  "src/app/api/cron/release-gate-check/route.ts",
  "src/app/api/jobs/goals-digest/route.ts",
  "src/app/api/cron/demo-canary/route.ts",
];

const GUARD_IMPORT = /@\/lib\/mail\/undeliverable-recipients/;

describe("recipient-guard coverage", () => {
  it.each(GUARDED_FAN_OUT_PATHS)(
    "%s imports the undeliverable-recipient guard",
    (rel) => {
      const src = fs.readFileSync(path.join(REPO, rel), "utf-8");
      expect(src).toMatch(GUARD_IMPORT);
    },
  );

  it.each(GUARDED_FAN_OUT_PATHS)(
    "%s applies the seed-exclusion predicate to its instinct_team_members query",
    (rel) => {
      const src = fs.readFileSync(path.join(REPO, rel), "utf-8");
      // If it reads team members, it must exclude seed rows in SQL.
      if (/instinct_team_members/.test(src)) {
        expect(src).toMatch(/seedEmailExclusionSql\(\)/);
      }
    },
  );

  it("the central sendViaGraph chokepoint enforces the guard for all callers", () => {
    const src = fs.readFileSync(
      path.join(REPO, "src/lib/mail/send-via-graph.ts"),
      "utf-8",
    );
    expect(src).toMatch(GUARD_IMPORT);
    expect(src).toMatch(/isSeedEmail\(args\.to\)/);
    expect(src).toMatch(/reason:\s*"seed_recipient"/);
  });
});
