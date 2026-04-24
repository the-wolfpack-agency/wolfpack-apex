/**
 * Structural invariants for migration 081_adopt_wolfpack_aidan_mulready.
 *
 * This migration is an INSERT (not a rename / schema change) so the
 * invariants are different from the 036-076 rename migrations: we assert
 * the INSERT targets the right table, carries the exact expected column
 * values, uses ON CONFLICT DO NOTHING for idempotency, wraps itself in a
 * defensive DO block, asserts post-insert row count, and inlines the
 * brief JSONB via dollar-quoting (safe against quote chars in content).
 *
 * A live-DB round-trip is the preferred test shape ("migrate up, row
 * exists, migrate down, row gone") but this repo's migration test suite
 * is uniformly structural — there is no live-PG test harness wired up
 * to jest. Keeping this test structural matches the surrounding pattern
 * (migration-055/056/057/058/077/078) and keeps CI fast + offline.
 * The idempotency contract (ON CONFLICT DO NOTHING + row-count assertion)
 * is enforced textually; the live round-trip is covered by the migration
 * runner's own smoke tests outside jest.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");
const UP_PATH = join(MIGRATIONS_DIR, "081_adopt_wolfpack_aidan_mulready.sql");
const DOWN_PATH = join(
  MIGRATIONS_DIR,
  "081_adopt_wolfpack_aidan_mulready.down.sql",
);

describe("migration 081 — adopt wolfpack-aidan-mulready", () => {
  describe("up migration", () => {
    const up = readFileSync(UP_PATH, "utf-8");

    it("file exists and is non-empty", () => {
      expect(existsSync(UP_PATH)).toBe(true);
      expect(statSync(UP_PATH).size).toBeGreaterThan(500);
    });

    it("wraps the body in BEGIN/COMMIT", () => {
      // Header comments precede BEGIN — match that BEGIN appears before
      // COMMIT with the DO block between them, rather than anchoring to ^.
      expect(up).toMatch(/BEGIN;[\s\S]+COMMIT;\s*$/);
    });

    it("is guarded by a defensive DO $$ ... $$ block", () => {
      expect(up).toMatch(/DO\s*\$\$[\s\S]+?\$\$;/);
    });

    it("references both the canonical table and the compat view name", () => {
      expect(up).toMatch(/instinct_site_projects/);
      expect(up).toMatch(/apex_site_projects/);
    });

    it("INSERTs into the site-projects table with the required columns", () => {
      // Column list is dynamic-format'd so assert every required column
      // appears in the INSERT statement.
      for (const col of [
        "id",
        "client_slug",
        "display_name",
        "brief",
        "github_repo",
        "github_repo_url",
        "preview_url",
        "status",
        "last_canary_passed",
        "created_by",
      ]) {
        expect(up).toMatch(new RegExp(`\\b${col}\\b`));
      }
      expect(up).toMatch(/INSERT INTO %I/);
    });

    it("carries the exact client_slug, display name, repo, and preview URL literals", () => {
      expect(up).toMatch(/'aidan-mulready'/);
      expect(up).toMatch(/'Aidan Mulready — CFTR'/);
      expect(up).toMatch(/'the-wolfpack-agency\/wolfpack-aidan-mulready'/);
      expect(up).toMatch(
        /'https:\/\/github\.com\/the-wolfpack-agency\/wolfpack-aidan-mulready'/,
      );
      expect(up).toMatch(/'https:\/\/wolfpack-aidan-mulready\.vercel\.app'/);
      expect(up).toMatch(/'ready'/);
      expect(up).toMatch(/'system'/);
    });

    it("marks last_canary_passed TRUE", () => {
      // The INSERT uses bind params via EXECUTE USING; the value flows
      // through as a bare TRUE literal in the USING list.
      expect(up).toMatch(/\bTRUE\b/);
    });

    it("uses ON CONFLICT (client_slug) DO NOTHING for idempotency", () => {
      expect(up).toMatch(/ON CONFLICT\s*\(client_slug\)\s+DO NOTHING/i);
    });

    it("inlines the brief as a dollar-quoted JSONB literal (safe against embedded quotes)", () => {
      // Dollar-quoted tag matches $brief$ ... $brief$.
      expect(up).toMatch(/\$brief\$/);
      expect(up).toMatch(/::jsonb/);
    });

    it("brief payload carries the CFTR identity fields verbatim", () => {
      // Key fields from briefs/aidan-mulready.json — if the inlined
      // copy drifts from the source JSON, this test catches it.
      expect(up).toMatch(/"client":\s*"aidan-mulready"/);
      expect(up).toMatch(/"name":\s*"Cleared for Takeoff Racing"/);
      expect(up).toMatch(/"heading":\s*"AIDAN MULREADY"/);
      expect(up).toMatch(/"domain":\s*"aidanmulready\.com"/);
      expect(up).toMatch(/"backgroundImage":\s*"\/cftr\/IMG_4182\.jpg"/);
    });

    it("snapshots pre-insert row count and asserts exactly 1 post-insert", () => {
      expect(up).toMatch(/existing_count/);
      expect(up).toMatch(/post_insert_count/);
      expect(up).toMatch(/post_insert_count != 1/);
    });

    it("short-circuits to NOTICE if the row already exists (no-op re-run)", () => {
      expect(up).toMatch(/already adopted/i);
      expect(up).toMatch(/RETURN;/);
    });

    it("aborts loudly if neither canonical nor legacy table exists", () => {
      expect(up).toMatch(/Neither instinct_site_projects nor apex_site_projects exists/);
      expect(up).toMatch(/RAISE EXCEPTION/);
    });
  });

  describe("down migration", () => {
    const down = readFileSync(DOWN_PATH, "utf-8");

    it("file exists and is non-empty", () => {
      expect(existsSync(DOWN_PATH)).toBe(true);
      expect(statSync(DOWN_PATH).size).toBeGreaterThan(200);
    });

    it("wraps the body in BEGIN/COMMIT", () => {
      expect(down).toMatch(/BEGIN;[\s\S]+COMMIT;\s*$/);
    });

    it("is guarded by a defensive DO $$ ... $$ block", () => {
      expect(down).toMatch(/DO\s*\$\$[\s\S]+?\$\$;/);
    });

    it("DELETEs the adopted row by client_slug only", () => {
      expect(down).toMatch(/DELETE FROM %I WHERE client_slug = \$1/);
      expect(down).toMatch(/'aidan-mulready'/);
    });

    it("no-ops cleanly if the row is already absent", () => {
      expect(down).toMatch(/pre_delete_count = 0/);
      expect(down).toMatch(/nothing to reverse/i);
    });

    it("refuses to proceed if >1 row matches (UNIQUE violation sentinel)", () => {
      expect(down).toMatch(/pre_delete_count > 1/);
      expect(down).toMatch(/refusing to delete/i);
    });

    it("asserts post-delete count is zero", () => {
      expect(down).toMatch(/post_delete_count/);
      expect(down).toMatch(/post_delete_count != 0/);
    });

    it("targets the same canonical/legacy table fallback logic as the up", () => {
      expect(down).toMatch(/instinct_site_projects/);
      expect(down).toMatch(/apex_site_projects/);
    });
  });

  describe("adoption contract", () => {
    const up = readFileSync(UP_PATH, "utf-8");

    it("slug matches the briefs filename convention (briefs/{client_slug}.json)", () => {
      // Instinct writes edits to briefs/{client_slug}.json in the repo.
      // The Aidan repo's brief is at briefs/aidan-mulready.json, so the
      // adopted slug MUST be aidan-mulready — not "cftr".
      expect(up).toMatch(/'aidan-mulready'/);
      expect(up).not.toMatch(/client_slug.*'cftr'/);
    });

    it("status is 'ready' so the site appears as live in the /sites list", () => {
      // draft/provisioning/deploying would hide the preview link + status
      // pill. 'ready' is the only value that shows the pill as green and
      // exposes the preview ↗ link in the sites list.
      expect(up).toMatch(/'ready'/);
    });

    it("created_by is 'system' (adoption, not a human-created site)", () => {
      expect(up).toMatch(/'system'/);
    });
  });
});
