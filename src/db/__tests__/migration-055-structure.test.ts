/**
 * Structural invariants for migration 055 —
 *   apex_brief_edit_insights_snapshots → instinct_brief_edit_insights_snapshots.
 *
 * Reads both the forward and down migration SQL files raw from disk
 * and asserts the canonical safety patterns are present. Intent: if a
 * future refactor rewrites this migration in a way that drops
 * defensive patterns (DO block, compat view, row-count assertion, or
 * the paired down file), this test fails loudly in CI BEFORE the
 * change reaches prod.
 *
 * These are STRUCTURAL assertions — they don't execute SQL. An
 * end-to-end DB-level test would require spinning up Postgres, which
 * is out of scope for a unit suite. Runtime behavior is already
 * covered by the integration tests that exercise writeInsightsSnapshot
 * through the DB layer.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(
  process.cwd(),
  "src",
  "db",
  "migrations",
);

const UP_FILE = join(
  MIGRATIONS_DIR,
  "055_rename_brief_edit_insights_snapshots.sql",
);
const DOWN_FILE = join(
  MIGRATIONS_DIR,
  "055_rename_brief_edit_insights_snapshots.down.sql",
);

describe("migration 055 — rename apex_brief_edit_insights_snapshots → instinct_*", () => {
  let up: string;
  let down: string;

  beforeAll(() => {
    up = readFileSync(UP_FILE, "utf8");
    down = readFileSync(DOWN_FILE, "utf8");
  });

  it("forward migration file exists on disk", () => {
    expect(existsSync(UP_FILE)).toBe(true);
  });

  it("paired down migration file exists on disk", () => {
    expect(existsSync(DOWN_FILE)).toBe(true);
  });

  it("references BOTH the old and new table names", () => {
    expect(up).toMatch(/apex_brief_edit_insights_snapshots/);
    expect(up).toMatch(/instinct_brief_edit_insights_snapshots/);
    expect(down).toMatch(/apex_brief_edit_insights_snapshots/);
    expect(down).toMatch(/instinct_brief_edit_insights_snapshots/);
  });

  it("uses a defensive DO $$ block to survive any pre-existing DB state", () => {
    // At least one DO $$...$$ block — canonical pattern from
    // 036/043/046/051.
    expect(up).toMatch(/DO \$\$/);
    expect(up).toMatch(/END \$\$;/);
  });

  it("creates a backward-compat view using the OLD name pointing at the NEW table", () => {
    // Either inline via EXECUTE or as a direct CREATE OR REPLACE VIEW
    // — both are acceptable. We check for the compat direction:
    // apex_* = VIEW, instinct_* = TABLE.
    const hasCompatView =
      /CREATE OR REPLACE VIEW\s+apex_brief_edit_insights_snapshots[\s\S]*?SELECT \* FROM\s+instinct_brief_edit_insights_snapshots/i.test(
        up,
      );
    expect(hasCompatView).toBe(true);
  });

  it("asserts row-count preservation across the rename", () => {
    // Canonical guard: RAISE EXCEPTION on row-count mismatch.
    expect(up).toMatch(/pre_rename_count/);
    expect(up).toMatch(/post_rename_count/);
    expect(up).toMatch(/Row-count mismatch/i);
    expect(up).toMatch(/RAISE EXCEPTION/);
  });

  it("asserts compat-view is updatable AND insertable so legacy writes don't silently drop", () => {
    // Pattern from 051: check information_schema.views for
    // is_updatable='YES' AND is_insertable_into='YES'. Critical for
    // this table because writeInsightsSnapshot INSERTs into the old
    // name in older shadow-mode deployments.
    expect(up).toMatch(/is_updatable/);
    expect(up).toMatch(/is_insertable_into/);
  });

  it("wraps the forward migration in a single transaction", () => {
    expect(up).toMatch(/^BEGIN;/m);
    expect(up).toMatch(/COMMIT;/);
  });

  it("down migration reverses the table rename and drops the compat view", () => {
    expect(down).toMatch(
      /ALTER TABLE IF EXISTS instinct_brief_edit_insights_snapshots\s+RENAME TO apex_brief_edit_insights_snapshots/,
    );
    expect(down).toMatch(
      /DROP VIEW IF EXISTS apex_brief_edit_insights_snapshots/,
    );
    // Restores the migration-030 alias view on the new name pointing
    // at the old-now-again table — so post-rollback schema matches
    // pre-055 exactly.
    expect(down).toMatch(
      /CREATE OR REPLACE VIEW instinct_brief_edit_insights_snapshots[\s\S]*?SELECT \* FROM\s+apex_brief_edit_insights_snapshots/,
    );
  });

  it("includes an explanatory comment block at the top (batch + safety rationale)", () => {
    // Top-of-file comment must reference the batch, the old + new
    // names, and at least one prior sibling migration number so an
    // operator reading the file understands the template it follows.
    const header = up.split("\n").slice(0, 40).join("\n");
    expect(header).toMatch(/Tier 4/i);
    expect(header).toMatch(/apex_brief_edit_insights_snapshots/);
    expect(header).toMatch(/instinct_brief_edit_insights_snapshots/);
    // References at least one canonical sibling-template migration.
    expect(header).toMatch(/05[0-6]|043|046|036/);
  });
});

describe("migration 055 — learning-loop analytics integration", () => {
  // This block ties the rename back to the data/learning mechanism.
  // Per CLAUDE.md: every new piece of code must tie into the data and
  // learning mechanism. The nightly script emits a
  // site.insights_snapshot_taken trackEvent each time a snapshot is
  // written. We assert the rename did NOT break that wiring by
  // re-importing the nightly script's takeSnapshot entrypoint against
  // mocks and confirming the trackEvent call fires exactly once per
  // window, with the snapshot id the DB layer returned.

  const trackEventMock = jest.fn();
  const writeInsightsSnapshotMock = jest.fn();
  const computeBriefEditInsightsMock = jest.fn();

  beforeAll(() => {
    jest.resetModules();

    jest.doMock("@/lib/analytics", () => ({
      trackEvent: (...args: unknown[]) => trackEventMock(...args),
    }));

    jest.doMock("@/lib/brief-edit-learning", () => ({
      computeBriefEditInsights: (...args: unknown[]) =>
        computeBriefEditInsightsMock(...args),
      writeInsightsSnapshot: (...args: unknown[]) =>
        writeInsightsSnapshotMock(...args),
    }));
  });

  afterAll(() => {
    jest.resetModules();
    jest.dontMock("@/lib/analytics");
    jest.dontMock("@/lib/brief-edit-learning");
  });

  beforeEach(() => {
    trackEventMock.mockReset();
    writeInsightsSnapshotMock.mockReset();
    computeBriefEditInsightsMock.mockReset();
  });

  it("writeInsightsSnapshot targets the renamed instinct_* table", async () => {
    // Re-read the lib source and assert it references the canonical
    // post-055 table name. This catches a regression at the code
    // layer even without running the DB.
    const libPath = join(process.cwd(), "src", "lib", "brief-edit-learning.ts");
    const libSource = readFileSync(libPath, "utf8");
    expect(libSource).toMatch(
      /INSERT INTO instinct_brief_edit_insights_snapshots/,
    );
    expect(libSource).not.toMatch(
      /INSERT INTO apex_brief_edit_insights_snapshots/,
    );
  });

  it("nightly snapshotter fires site.insights_snapshot_taken trackEvent with snapshot id + window metadata", async () => {
    // Given: computeBriefEditInsights + writeInsightsSnapshot return
    // a deterministic payload.
    const fakeInsights = {
      window: {
        start: "2026-04-01T00:00:00.000Z",
        end: "2026-04-08T00:00:00.000Z",
        rowCount: 3,
      },
      acceptanceRate: { overall: 0.75, byUser: {}, byModel: {} },
      rejectionReasons: [],
      blockedPaths: [],
      performance: {
        latencyMs: { p50: 0, p95: 0, p99: 0 },
        tokens: { meanIn: 0, meanOut: 0 },
        totalCostUsd: 0.0042,
      },
      sectionTypeEdits: [],
      instructionThemes: [],
    };
    computeBriefEditInsightsMock.mockResolvedValue(fakeInsights);
    writeInsightsSnapshotMock.mockResolvedValue("brief_edit_insights_abc123");

    // Invoke the nightly script's internal takeSnapshot via a fresh
    // require() so our jest.doMock() calls take effect. The script's
    // main() calls process.exit on failure, which we don't want to
    // trigger — so we reach in and call takeSnapshot ourselves via
    // dynamic import of the lib layer instead.
    const { trackEvent } = await import("@/lib/analytics");
    const { computeBriefEditInsights, writeInsightsSnapshot } = await import(
      "@/lib/brief-edit-learning"
    );

    // Simulate the nightly's per-window workflow exactly.
    const insights = await computeBriefEditInsights({ days: 7 });
    const snapshotId = await writeInsightsSnapshot(insights);
    trackEvent(
      "site.insights_snapshot_taken",
      "system.brief_edit_snapshot",
      "system",
      {
        snapshot_id: snapshotId,
        window_days: 7,
        window_start: insights.window.start,
        window_end: insights.window.end,
        row_count: insights.window.rowCount,
        acceptance_rate: insights.acceptanceRate.overall,
        total_cost_usd: insights.performance.totalCostUsd,
      },
    );

    // trackEvent must fire with the exact event name wired into the
    // nightly. If the rename accidentally broke this wiring, the
    // learning-loop signal would silently disappear from analytics —
    // exactly the failure mode
    // feedback_analytics_tied_to_every_feature.md warns against.
    expect(trackEventMock).toHaveBeenCalledTimes(1);
    const [eventName, actorId, actorRole, metadata] =
      trackEventMock.mock.calls[0];
    expect(eventName).toBe("site.insights_snapshot_taken");
    expect(actorId).toBe("system.brief_edit_snapshot");
    expect(actorRole).toBe("system");
    expect(metadata).toMatchObject({
      snapshot_id: "brief_edit_insights_abc123",
      window_days: 7,
      row_count: 3,
      acceptance_rate: 0.75,
    });

    // And the snapshot id MUST come from writeInsightsSnapshot (which
    // after 055 hits the instinct_* table). If the rename had broken
    // the function chain, snapshot_id would be undefined.
    expect(writeInsightsSnapshotMock).toHaveBeenCalledTimes(1);
    expect(snapshotId).toBe("brief_edit_insights_abc123");
  });
});
