/**
 * The assurance report is honest by construction: a claimed-but-dark control
 * reads as a gap, never as protection. A fresh, unconfigured deployment must
 * show its gaps; a fully-armed one must not overstate.
 */
import { buildAssuranceReport, type AssuranceInput } from "@/lib/forcefield/assurance";

const bare: AssuranceInput = {
  enforceMode: "monitor", autoBlockEnabled: false, delegationIssuers: 0, asymmetricIssuers: 0,
  decoysSeeded: 0, reputationConsume: false, hybridTlsAsserted: false, externalAuditAnchor: false, ingestSourceSigned: false, pqQuantumVulnerable: 2, pqSlotImplemented: false,
};

const armed: AssuranceInput = {
  enforceMode: "enforce", autoBlockEnabled: true, delegationIssuers: 3, asymmetricIssuers: 2,
  decoysSeeded: 5, reputationConsume: true, hybridTlsAsserted: true, externalAuditAnchor: true, ingestSourceSigned: true, pqQuantumVulnerable: 2, pqSlotImplemented: false,
};

const byId = (r: ReturnType<typeof buildAssuranceReport>, id: string) => r.controls.find((c) => c.id === id)!;

describe("buildAssuranceReport", () => {
  it("shows the gaps honestly on a bare deployment (does not overstate)", () => {
    const r = buildAssuranceReport(bare);
    expect(byId(r, "enforce.inline").status).toBe("gap");       // monitor => not protecting
    expect(byId(r, "enforce.auto_block").status).toBe("gap");
    expect(byId(r, "detect.decoys").status).toBe("gap");
    expect(byId(r, "verify.principal").status).toBe("gap");
    expect(byId(r, "ingest.source_signed").status).toBe("gap");
    expect(byId(r, "audit.external_anchor").status).toBe("gap");
    expect(r.gapCount).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(50);
    // every gap tells you how to close it (actionable checklist)
    expect(byId(r, "enforce.inline").enablement).toMatch(/enforce|protection/i);
    expect(byId(r, "detect.decoys").enablement).toMatch(/decoy/i);
  });

  it("reflects an armed deployment, but never claims 100 while any control is only partial", () => {
    const r = buildAssuranceReport(armed);
    expect(byId(r, "enforce.inline").status).toBe("active");
    expect(byId(r, "enforce.auto_block").status).toBe("active");
    expect(byId(r, "verify.asymmetric").status).toBe("active");
    expect(byId(r, "crypto.pq_transport").status).toBe("active");
    // pq_signatures stays partial (ML-DSA reserved) - honesty rail
    expect(byId(r, "crypto.pq_signatures").status).toBe("partial");
    expect(r.score).toBeLessThan(100);
    expect(r.score).toBeGreaterThan(85);
  });

  it("auto-block only counts active when enforcement is actually on", () => {
    const r = buildAssuranceReport({ ...bare, autoBlockEnabled: true, enforceMode: "monitor" });
    expect(byId(r, "enforce.auto_block").status).toBe("gap");
  });
});
