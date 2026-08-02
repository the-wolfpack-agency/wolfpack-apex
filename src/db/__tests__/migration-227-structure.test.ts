/**
 * Structural invariants for migration 227_agent_containment_state.
 *
 * Raw SQL only. The invariant that matters most is the seeded default row: the
 * read path treats a missing row as UNREADABLE, which halts agent work, so a
 * migration that created the table without the row would stop every agent in
 * the workspace the moment it deployed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "..", "migrations");
const up = readFileSync(join(DIR, "227_agent_containment_state.sql"), "utf8");
const down = readFileSync(join(DIR, "227_agent_containment_state.down.sql"), "utf8");

describe("migration 227 — agent containment state", () => {
  it("creates both tables idempotently", () => {
    expect(up).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+instinct_agent_containment\b/);
    expect(up).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+instinct_agent_run_spend\b/);
  });

  it("seeds the default workspace as ENABLED, because a missing row halts agents", () => {
    // readContainmentState returns { readable: false } for a missing row, and
    // decideStep treats unreadable as stop. Without this insert, deploying the
    // migration would stop every agent until someone noticed.
    expect(up).toMatch(/INSERT\s+INTO\s+instinct_agent_containment[\s\S]*VALUES\s*\(\s*'default'\s*,\s*TRUE\s*\)/i);
    expect(up).toMatch(/ON\s+CONFLICT\s*\(\s*workspace_id\s*\)\s*DO\s+NOTHING/i);
  });

  it("defaults agents_enabled to true at the column level too", () => {
    // A row inserted by any other path must not arrive stopped.
    expect(up).toMatch(/agents_enabled\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+TRUE/i);
  });

  it("records who stopped it and why", () => {
    for (const col of ["stopped_reason", "stopped_by", "stopped_at"]) expect(up).toContain(col);
  });

  it("stores the budget alongside the spend, so a run's ceiling is auditable", () => {
    // Without the budget on the row, you cannot tell whether a stopped run hit
    // the default or a limit someone deliberately raised.
    expect(up).toMatch(/budget\s+JSONB\s+NOT\s+NULL/i);
  });

  it("scopes both tables by workspace as TEXT", () => {
    expect(up).toMatch(/workspace_id\s+TEXT\s+PRIMARY\s+KEY/i);
    expect(up).toMatch(/workspace_id\s+TEXT\s+NOT\s+NULL/i);
  });

  it("guards every index, including on the way down", () => {
    for (const stmt of up.match(/CREATE\s+INDEX[^;]*/gi) ?? []) expect(stmt).toMatch(/IF\s+NOT\s+EXISTS/i);
    const drops = down.match(/DROP\s+(INDEX|TABLE)[^;]*/gi) ?? [];
    expect(drops.length).toBeGreaterThan(0);
    for (const stmt of drops) expect(stmt).toMatch(/IF\s+EXISTS/i);
  });

  it("indexes the breached-runs view that answers whether budgets are set right", () => {
    expect(up).toMatch(/idx_agent_run_spend_breached[\s\S]*WHERE\s+breached\s+IS\s+NOT\s+NULL/i);
  });
});
