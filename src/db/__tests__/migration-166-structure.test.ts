/**
 * Structural invariant test for 166_ai_gateway_governance.sql.
 *
 * Locks the AI gateway governance schema:
 *   - workspace_ai_policy table is idempotent (IF NOT EXISTS) with the
 *     tier/provider/budget CHECK constraints and RLS enabled.
 *   - v_ai_cost_daily aggregates the ai.completion event stream by
 *     workspace/feature/provider/model and sums cost + tokens.
 *   - Paired .down.sql drops both, in dependency order (view first).
 *
 * If a future edit weakens these guarantees the test fails before ship.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "..", "migrations");
const UP = readFileSync(join(DIR, "166_ai_gateway_governance.sql"), "utf-8");
const DOWN_PATH = join(DIR, "166_ai_gateway_governance.down.sql");

describe("migration 166, up", () => {
  it("creates workspace_ai_policy idempotently with a primary key", () => {
    expect(UP).toMatch(/CREATE TABLE IF NOT EXISTS workspace_ai_policy/);
    expect(UP).toMatch(/workspace_id\s+TEXT PRIMARY KEY/);
  });

  it("constrains tier, provider, and budget to safe values", () => {
    expect(UP).toMatch(/max_tier IN \('cheap', 'standard', 'premium'\)/);
    expect(UP).toMatch(/provider_override IN \('anthropic', 'azure-openai'\)/);
    expect(UP).toMatch(/monthly_budget_usd\s+>=\s+0/);
  });

  it("enables RLS with a policy (repo bar)", () => {
    expect(UP).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(UP).toMatch(/CREATE POLICY workspace_ai_policy_all/);
  });

  it("builds the chargeback view over ai.completion events", () => {
    expect(UP).toMatch(/CREATE OR REPLACE VIEW v_ai_cost_daily/);
    expect(UP).toMatch(/event_type = 'ai\.completion'/);
    // Attribution dimensions.
    expect(UP).toMatch(/metadata->>'workspace_id'/);
    expect(UP).toMatch(/metadata->>'feature'/);
    // Spend + token rollups.
    expect(UP).toMatch(/SUM\(NULLIF\(metadata->>'cost_usd'/);
    expect(UP).toMatch(/metadata->>'input_tokens'/);
    expect(UP).toMatch(/metadata->>'output_tokens'/);
    // Savings signals.
    expect(UP).toMatch(/semantic_hit/);
    expect(UP).toMatch(/fallback_used/);
  });

  it("guards numeric casts against empty strings (no view-time crash)", () => {
    expect(UP).toMatch(/NULLIF\(metadata->>'cost_usd', ''\)::numeric/);
  });
});

describe("migration 166, down", () => {
  const down = existsSync(DOWN_PATH) ? readFileSync(DOWN_PATH, "utf-8") : "";

  it("exists and drops view then table (dependency order)", () => {
    expect(down).not.toBe("");
    expect(down).toMatch(/DROP VIEW IF EXISTS v_ai_cost_daily/);
    expect(down).toMatch(/DROP TABLE IF EXISTS workspace_ai_policy/);
    expect(down.indexOf("DROP VIEW")).toBeLessThan(down.indexOf("DROP TABLE"));
  });
});
