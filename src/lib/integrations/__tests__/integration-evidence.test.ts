/**
 * The inventory has to know about every integration that exists.
 *
 * Eighteen Microsoft Graph surfaces are built. Before a client call that is a
 * tempting number to say out loud and it is the wrong one: measured over
 * ninety days of production, nine were active, three stale, and six had never
 * been exercised at all. "Twelve have run in production" is a claim that
 * survives somebody asking to see it; "eighteen integrations" is not.
 *
 * A report is only worth trusting if it cannot quietly go out of date. A new
 * integration module that nobody adds to SURFACES would be absent from the
 * inventory, and absent reads exactly like unproven, so the next person would
 * under-claim a thing that works. This fails the build instead.
 */
import fs from "node:fs";
import path from "node:path";
import { SURFACES, verdict, type Evidence } from "../../../../scripts/integration-evidence";

const DIR = path.resolve(__dirname, "..");

function modulesOnDisk(): string[] {
  return fs
    .readdirSync(DIR)
    .filter((f) => f.startsWith("microsoft-") && f.endsWith(".ts"))
    .map((f) => f.replace(/\.ts$/, ""))
    .sort();
}

describe("the integration inventory", () => {
  it("covers every Microsoft integration module on disk", () => {
    const listed = SURFACES.map((s) => s.module).sort();
    const missing = modulesOnDisk().filter((m) => !listed.includes(m));
    expect(missing).toEqual([]);
  });

  /* The other direction. A module that was deleted but left in the list would
     report as "never exercised" forever, which is a real-looking zero for a
     thing that no longer exists. */
  it("does not list a module that has been removed", () => {
    const onDisk = modulesOnDisk();
    const orphans = SURFACES.map((s) => s.module).filter((m) => !onDisk.includes(m));
    expect(orphans).toEqual([]);
  });

  it("gives every surface at least one way to find its events", () => {
    for (const s of SURFACES) {
      expect(s.patterns.length).toBeGreaterThan(0);
      for (const p of s.patterns) expect(p).toMatch(/%/);
    }
  });
});

describe("the verdict", () => {
  const base: Evidence = { label: "X", module: "m", events: 10, lastSeen: "2026-08-26", ageDays: 1 };

  it("calls a recently used surface active", () => {
    expect(verdict({ ...base, ageDays: 3 })).toBe("active");
  });

  /* A fortnight, so a quiet week does not read as broken and "it worked in
     June" does not read as working. */
  it("calls a surface stale once it is older than a fortnight", () => {
    expect(verdict({ ...base, ageDays: 15 })).toBe("stale");
  });

  /* Zero events is the claim worth being careful about: it is the difference
     between a surface we can demonstrate and one we can only describe. */
  it("calls a surface with no events unproven, never active", () => {
    expect(verdict({ ...base, events: 0, ageDays: null, lastSeen: null })).toBe("unproven");
  });

  /* Guards the boundary from being written as `< 14`, which would call a
     fourteen-day-old surface stale and quietly shrink what we can claim. */
  it("treats exactly a fortnight as still active", () => {
    expect(verdict({ ...base, ageDays: 14 })).toBe("active");
  });
});
