import { THREAT_COVERAGE, coverageSummary, type ThreatEntry } from "@/lib/forcefield/threat-coverage";
import { PROBE_SIGNATURES } from "@/lib/agent-probe-signatures";

describe("threat-coverage matrix", () => {
  it("has unique, well-formed entries", () => {
    const ids = THREAT_COVERAGE.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate threats
    for (const e of THREAT_COVERAGE) {
      expect(e.name.length).toBeGreaterThan(3);
      expect(e.note.length).toBeGreaterThan(10);
      // covered/partial must cite a live lens; not-agent-observable cites none;
      // a gap may still carry an OFFLINE lens (exercised, but not live) - e.g.
      // prompt injection is red-teamed offline yet a live-traffic gap.
      if (e.status === "covered" || e.status === "partial") expect(e.lenses.length).toBeGreaterThan(0);
      if (e.status === "not-agent-observable") expect(e.lenses).toEqual([]);
      if (e.status === "gap") expect(e.lenses.every((l) => l === "red-team-offline")).toBe(true);
    }
  });

  // PARITY: the matrix cannot silently drift from the real probe detector.
  it("marks every CWE the probe lens emits as covered on the probe-path lens", () => {
    const probeCwes = Array.from(new Set(PROBE_SIGNATURES.map((s) => s.cwe)));
    for (const cwe of probeCwes) {
      const entry = THREAT_COVERAGE.find((e) => e.id === cwe);
      expect(entry).toBeDefined(); // probe CWE must be in the matrix
      expect(entry!.lenses).toContain("probe-path");
      expect(["covered", "partial"]).toContain(entry!.status);
    }
  });

  // Prompt injection now has LIVE inbound detection (OGIAM payload lens).
  it("covers prompt injection (CWE-1427) on the live payload lens", () => {
    const pi = THREAT_COVERAGE.find((e) => e.id === "CWE-1427")!;
    expect(pi.status).toBe("covered");
    expect(pi.lenses).toContain("payload");
  });

  it("covers the payload-lens agent-pivot classes (SSRF-param, open redirect, XXE, upload)", () => {
    for (const id of ["CWE-918", "CWE-601", "CWE-611", "CWE-434"]) {
      const e = THREAT_COVERAGE.find((x) => x.id === id)!;
      expect(e.status).toBe("covered");
      expect(e.lenses).toContain("payload");
    }
  });

  it("marks memory-safety CWEs as not-agent-observable (static-scan domain), not gaps", () => {
    for (const id of ["CWE-787", "CWE-125", "CWE-416"]) {
      expect(THREAT_COVERAGE.find((e) => e.id === id)!.status).toBe("not-agent-observable");
    }
  });

  it("covers the OWASP-LLM agent classes (LLM07/LLM08 covered, LLM01/LLM02 flagged)", () => {
    expect(THREAT_COVERAGE.find((e) => e.id === "LLM07")!.status).toBe("covered");
    expect(THREAT_COVERAGE.find((e) => e.id === "LLM08")!.status).toBe("covered");
    expect(THREAT_COVERAGE.find((e) => e.id === "LLM02")!.status).toBe("gap");
  });

  it("the behavior-lens gaps are now covered (IDOR enumeration, runaway-loop exhaustion)", () => {
    const idor = THREAT_COVERAGE.find((e) => e.id === "CWE-639")!;
    expect(idor.status).toBe("covered");
    expect(idor.lenses).toContain("agent-behavior");
    const dos = THREAT_COVERAGE.find((e) => e.id === "CWE-770")!;
    expect(dos.status).toBe("covered");
    expect(dos.lenses).toContain("agent-behavior");
  });
});

describe("coverageSummary", () => {
  it("counts by status and reports the honest observable-detected headline", () => {
    const s = coverageSummary();
    expect(s.total).toBe(THREAT_COVERAGE.length);
    expect(s.covered + s.partial + s.gap + s.notAgentObservable).toBe(s.total);
    // observable total excludes not-agent-observable; detected = covered + partial
    expect(s.observableTotal).toBe(s.total - s.notAgentObservable);
    expect(s.observableDetected).toBe(s.covered + s.partial);
    expect(s.gaps.every((g: ThreatEntry) => g.status === "gap")).toBe(true);
    expect(s.gaps.length).toBeGreaterThan(0); // gaps are named, not hidden
  });
});
