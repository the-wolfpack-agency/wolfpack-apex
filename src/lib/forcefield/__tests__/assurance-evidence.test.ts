/**
 * The assurance evidence gatherer: every control key has a windowed query, a
 * failing query reads as an error probe (unknown, never "none"), and the
 * tripwire self-test drives the REAL inspectAgentAction with the live caller's
 * action shape.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { ASSURANCE_EVIDENCE_KEYS } from "@/lib/forcefield/assurance";
import {
  ASSURANCE_SITE,
  WINDOWS,
  assuranceProbeSpecs,
  collectAssuranceEvidence,
  tripwireSelfTest,
} from "@/lib/forcefield/assurance-evidence";
import type { EvidenceExecutor } from "@/lib/compliance/evidence-window";
import type { Canary } from "@/lib/forcefield/tripwire";

const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe("probe specs", () => {
  const specs = assuranceProbeSpecs("w1");

  it("every evidence key has exactly one spec, keyed consistently", () => {
    expect(Object.keys(specs).sort()).toEqual([...ASSURANCE_EVIDENCE_KEYS].sort());
    for (const [k, s] of Object.entries(specs)) expect(s.key).toBe(k);
  });

  it("every spec is a read-only SELECT with a window and a proof statement", () => {
    for (const s of Object.values(specs)) {
      expect(s.sql.trim()).toMatch(/^(SELECT|WITH)\b/);
      expect(s.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i);
      expect(s.windowDays).toBeGreaterThan(0);
      expect(s.proof.length).toBeGreaterThan(10);
    }
  });

  it("inline enforcement needs blocked=true events on THIS site in 7d", () => {
    const s = specs["ff.inline_block"];
    expect(s.windowDays).toBe(WINDOWS.block);
    expect(s.windowDays).toBe(7);
    expect(s.sql).toMatch(/props->>'blocked' = 'true'/);
    expect(s.params).toEqual([ASSURANCE_SITE]);
  });

  it("alerts look for web_alert_dispatched in 30d", () => {
    expect(specs["ff.alert_dispatched"].sql).toMatch(/forcefield\.web_alert_dispatched/);
    expect(specs["ff.alert_dispatched"].windowDays).toBe(30);
  });

  it("the chain probe requires the NEWEST verification to have passed", () => {
    expect(specs["audit.chain_verified"].sql).toMatch(/ORDER BY "timestamp" DESC\s+LIMIT 1/);
  });

  it("workspace-scoped evidence is filtered by workspace", () => {
    expect(specs["ff.delegation_verified"].params).toEqual(["w1"]);
    expect(specs["ff.agent_dispatch"].params).toEqual(["w1"]);
  });

  it("ASSURANCE_SITE matches the site key middleware.ts records under", () => {
    const mw = readFileSync(join(process.cwd(), "src/middleware.ts"), "utf8");
    expect(mw).toContain(`site: "${ASSURANCE_SITE}"`);
  });
});

describe("tripwireSelfTest (real inspectAgentAction)", () => {
  const c = (kind: Canary["kind"], value: string): Canary => ({ id: value, kind, value, seededIn: "test" });

  it("a token canary in the live caller's payload trips and quarantines", () => {
    expect(tripwireSelfTest([c("token", "ff-canary-abc123")])).toEqual({ reachable: 1, tripped: 1, unreachableKinds: [] });
  });

  it("route / row / tool canaries are reported unreachable, not counted as protection", () => {
    const r = tripwireSelfTest([c("route", "/decoy"), c("row", "r1"), c("tool", "admin_bulk_export_x")]);
    expect(r.reachable).toBe(0);
    expect(r.unreachableKinds).toEqual(["route", "row", "tool"]);
  });

  it("an empty-valued token canary cannot trip, so the self-test fails", () => {
    const r = tripwireSelfTest([c("token", "")]);
    expect(r.reachable).toBe(1);
    expect(r.tripped).toBe(0);
  });
});

describe("collectAssuranceEvidence", () => {
  const canaryRows = { rows: [{ id: "1", kind: "token", value: "ff-canary-zz", seeded_in: "kb" }] };

  it("fresh rows -> fresh probes; canaries feed the self-test", async () => {
    const exec: EvidenceExecutor = async (sql) =>
      /instinct_forcefield_canaries/.test(sql) ? canaryRows : { rows: [{ n: 4, last: day(1) }] };
    const e = await collectAssuranceEvidence("w1", exec, NOW);
    for (const k of ASSURANCE_EVIDENCE_KEYS) expect(e.probes[k].state).toBe("fresh");
    expect(e.tripwire).toEqual({ reachable: 1, tripped: 1, unreachableKinds: [] });
  });

  it("only old rows -> stale probes", async () => {
    const exec: EvidenceExecutor = async (sql) =>
      /instinct_forcefield_canaries/.test(sql) ? canaryRows : { rows: [{ n: 0, last: day(60) }] };
    const e = await collectAssuranceEvidence("w1", exec, NOW);
    for (const k of ASSURANCE_EVIDENCE_KEYS) expect(e.probes[k].state).toBe("stale");
  });

  it("a missing table or a dead connection -> error probes (unknown), never none", async () => {
    const exec: EvidenceExecutor = async () => {
      throw new Error('relation "instinct_delegation_replay" does not exist\npostgres://user:pw@host/db');
    };
    const e = await collectAssuranceEvidence("w1", exec, NOW);
    for (const k of ASSURANCE_EVIDENCE_KEYS) {
      expect(e.probes[k].state).toBe("error");
      expect(e.probes[k].error).not.toMatch(/postgres:\/\//);
    }
    expect(e.tripwire).toBeNull();
  });

  it("no database configured -> every probe is an error, tripwire null", async () => {
    const e = await collectAssuranceEvidence("w1", null, NOW);
    for (const k of ASSURANCE_EVIDENCE_KEYS) expect(e.probes[k].state).toBe("error");
    expect(e.tripwire).toBeNull();
  });
});
