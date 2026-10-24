/**
 * The assurance report is computed from execution evidence, never configuration.
 * For every control: fresh evidence -> active, stale or absent evidence -> gap,
 * a failed query -> unknown. Nothing reads "active" on an armed config alone.
 */
import {
  ASSURANCE_EVIDENCE_KEYS,
  buildAssuranceReport,
  type AssuranceEvidenceKey,
  type AssuranceInput,
  type ControlStatus,
} from "@/lib/forcefield/assurance";
import type { EvidenceProbe, EvidenceState } from "@/lib/compliance/evidence-window";

const NOW = new Date("2026-10-24T12:00:00.000Z");

function probe(key: string, state: EvidenceState): EvidenceProbe {
  switch (state) {
    case "fresh":
      return { key, proof: key, windowDays: 7, count: 3, lastAt: "2026-10-23T00:00:00.000Z", state };
    case "stale":
      return { key, proof: key, windowDays: 7, count: 0, lastAt: "2026-08-01T00:00:00.000Z", state };
    case "none":
      return { key, proof: key, windowDays: 7, count: 0, lastAt: null, state };
    case "error":
      return { key, proof: key, windowDays: 7, count: 0, lastAt: null, state, error: 'relation "x" does not exist' };
  }
}

const allProbes = (state: EvidenceState) =>
  Object.fromEntries(ASSURANCE_EVIDENCE_KEYS.map((k) => [k, probe(k, state)])) as Record<AssuranceEvidenceKey, EvidenceProbe>;

/** Fully-armed CONFIG: enforce, auto-block, issuers, opt-in, signing - every flag on. */
const armedConfig: Omit<AssuranceInput, "probes" | "samples"> = {
  site: "instinct",
  enforceMode: "enforce",
  autoBlockEnabled: true,
  delegationIssuers: 3,
  asymmetricIssuers: 2,
  reputationConsume: true,
  ingestSigningEnforced: true,
  ingestSources: 2,
  hybridTlsAssertedInCi: true,
  pqQuantumVulnerable: 2,
  pqSlotImplemented: false,
};

const passingSamples = { replay: true, injectionAsData: true, tripwire: { reachable: 1, tripped: 1, unreachableKinds: [] } };

const input = (state: EvidenceState, over: Partial<AssuranceInput> = {}): AssuranceInput => ({
  ...armedConfig,
  probes: allProbes(state),
  samples: passingSamples,
  ...over,
});

const byId = (r: ReturnType<typeof buildAssuranceReport>, id: string) => {
  const c = r.controls.find((x) => x.id === id);
  if (!c) throw new Error(`no control ${id}`);
  return c;
};

/** Controls whose status is derived from windowed evidence probes. */
const EVIDENCE_CONTROLS = [
  "enforce.inline",
  "enforce.auto_block",
  "enforce.never_blinds",
  "detect.decoys",
  "detect.tripwire",
  "alerts.dispatch",
  "verify.principal",
  "verify.replay",
  "verify.asymmetric",
  "network.reputation",
  "audit.hash_chain",
  "audit.external_anchor",
];

describe("buildAssuranceReport: fresh / stale / error per control", () => {
  it.each(EVIDENCE_CONTROLS)("%s: fresh evidence -> active", (id) => {
    expect(byId(buildAssuranceReport(input("fresh"), NOW), id).status).toBe("active");
  });

  it.each(EVIDENCE_CONTROLS)("%s: stale evidence -> gap (an armed config does not rescue it)", (id) => {
    expect(byId(buildAssuranceReport(input("stale"), NOW), id).status).toBe("gap");
  });

  it.each(EVIDENCE_CONTROLS)("%s: no evidence at all -> gap", (id) => {
    expect(byId(buildAssuranceReport(input("none"), NOW), id).status).toBe("gap");
  });

  it.each(EVIDENCE_CONTROLS)("%s: query error -> unknown, never active", (id) => {
    expect(byId(buildAssuranceReport(input("error"), NOW), id).status).toBe("unknown");
  });

  it.each(EVIDENCE_CONTROLS)("%s: evidence missing from the input -> unknown, never active", (id) => {
    const s = byId(buildAssuranceReport(input("fresh", { probes: {} }), NOW), id).status;
    expect(s).not.toBe("active");
  });

  it("every evidence-backed control names the evidence it rests on", () => {
    const r = buildAssuranceReport(input("fresh"), NOW);
    for (const id of EVIDENCE_CONTROLS) expect(byId(r, id).evidence.length).toBeGreaterThan(0);
  });
});

describe("the audit's hard-coded / config-only findings", () => {
  const stale = buildAssuranceReport(input("stale"), NOW);

  it("enforce.inline does not read active from policy mode=enforce alone", () => {
    expect(byId(stale, "enforce.inline").status).toBe("gap");
    expect(byId(stale, "enforce.inline").detail).toMatch(/not proof of a block/);
  });

  it("verify.replay, deterministic_gate, never_blinds, hash_chain are no longer hard-coded", () => {
    expect(byId(stale, "verify.replay").status).toBe("gap");
    expect(byId(stale, "enforce.never_blinds").status).toBe("gap");
    expect(byId(stale, "audit.hash_chain").status).toBe("gap");
    const failedInjection = buildAssuranceReport(input("fresh", { samples: { ...passingSamples, injectionAsData: false } }), NOW);
    expect(byId(failedInjection, "defense.deterministic_gate").status).toBe("gap");
    const notRun = buildAssuranceReport(input("fresh", { samples: { ...passingSamples, injectionAsData: null } }), NOW);
    expect(byId(notRun, "defense.deterministic_gate").status).toBe("unknown");
  });

  it("verify.replay: a FAILED replay sample is a gap even with fresh live evidence", () => {
    const r = buildAssuranceReport(input("fresh", { samples: { ...passingSamples, replay: false } }), NOW);
    expect(byId(r, "verify.replay").status).toBe("gap");
    expect(byId(r, "verify.replay").detail).toMatch(/FAILED/);
  });

  it("network.reputation does not read active from the opt-in flag alone", () => {
    expect(byId(stale, "network.reputation").status).toBe("gap");
    const optedOut = buildAssuranceReport(input("fresh", { reputationConsume: false }), NOW);
    expect(byId(optedOut, "network.reputation").status).toBe("gap");
  });

  it("enforce.auto_block: events firing while the policy toggle is off read partial, not active", () => {
    const r = buildAssuranceReport(input("fresh", { autoBlockEnabled: false }), NOW);
    expect(byId(r, "enforce.auto_block").status).toBe("partial");
  });

  it("alerts: hostile events with no dispatched alert is a gap", () => {
    const probes = { ...allProbes("fresh"), "ff.alert_dispatched": probe("ff.alert_dispatched", "stale") };
    const r = buildAssuranceReport(input("fresh", { probes }), NOW);
    expect(byId(r, "alerts.dispatch").status).toBe("gap");
    expect(byId(r, "alerts.dispatch").detail).toMatch(/no alert was dispatched/);
  });

  it("tripwire: a failed self-test, no reachable canary, or no dispatch is never active", () => {
    const failed = buildAssuranceReport(input("fresh", { samples: { ...passingSamples, tripwire: { reachable: 2, tripped: 1, unreachableKinds: [] } } }), NOW);
    expect(byId(failed, "detect.tripwire").status).toBe("gap");
    const unreachable = buildAssuranceReport(
      input("fresh", { samples: { ...passingSamples, tripwire: { reachable: 0, tripped: 0, unreachableKinds: ["route", "row", "tool"] } } }),
      NOW,
    );
    expect(byId(unreachable, "detect.tripwire").status).toBe("gap");
    expect(byId(unreachable, "detect.tripwire").detail).toMatch(/unreachable kinds: route, row, tool/);
    const armedNotRunning = buildAssuranceReport(
      input("fresh", { probes: { ...allProbes("fresh"), "ff.agent_dispatch": probe("ff.agent_dispatch", "none") } }),
      NOW,
    );
    expect(byId(armedNotRunning, "detect.tripwire").status).toBe("gap");
    expect(byId(armedNotRunning, "detect.tripwire").detail).toMatch(/armed, not running/);
    const unread = buildAssuranceReport(input("fresh", { samples: { ...passingSamples, tripwire: null } }), NOW);
    expect(byId(unread, "detect.tripwire").status).toBe("unknown");
  });

  it("signed ingest can never read active (no execution record exists)", () => {
    expect(byId(buildAssuranceReport(input("fresh"), NOW), "ingest.source_signed").status).toBe("gap");
    expect(byId(buildAssuranceReport(input("fresh", { ingestSources: null }), NOW), "ingest.source_signed").status).toBe("unknown");
  });

  it("PQ: transport is at most partial, signatures are a gap while the slot is reserved", () => {
    const r = buildAssuranceReport(input("fresh"), NOW);
    expect(byId(r, "crypto.pq_transport").status).toBe("partial");
    expect(byId(r, "crypto.pq_signatures").status).toBe("gap");
    expect(byId(buildAssuranceReport(input("fresh", { hybridTlsAssertedInCi: false }), NOW), "crypto.pq_transport").status).toBe("unknown");
  });
});

describe("report totals", () => {
  const statuses = (r: ReturnType<typeof buildAssuranceReport>): ControlStatus[] => r.controls.map((c) => c.status);

  it("counts add up and unknown scores zero", () => {
    for (const st of ["fresh", "stale", "none", "error"] as const) {
      const r = buildAssuranceReport(input(st), NOW);
      expect(r.activeCount + r.partialCount + r.gapCount + r.unknownCount).toBe(r.total);
      expect(statuses(r).filter((s) => s === "unknown").length).toBe(r.unknownCount);
    }
    expect(buildAssuranceReport(input("error"), NOW).score).toBeLessThan(10);
  });

  it("never 100 while any control is partial or a gap; fully proven still under 100", () => {
    const r = buildAssuranceReport(input("fresh"), NOW);
    expect(r.score).toBeLessThan(100);
    expect(r.score).toBeGreaterThan(70);
    expect(r.measuredAt).toBe(NOW.toISOString());
  });

  it("a non-active control carries an enablement step", () => {
    const r = buildAssuranceReport(input("none"), NOW);
    expect(byId(r, "enforce.inline").enablement).toMatch(/enforce|protection/i);
    expect(byId(r, "detect.tripwire").enablement).toMatch(/token canary/);
    expect(byId(buildAssuranceReport(input("fresh"), NOW), "enforce.inline").enablement).toBeUndefined();
  });
});
