import { THREAT_COVERAGE, THREAT_SPECS, coverageSummary, evaluateCoverage, runThreatCheck, type ThreatEntry, type ThreatSpec } from "@/lib/forcefield/threat-coverage";
import { PROBE_SIGNATURES } from "@/lib/agent-probe-signatures";

// The matrix is COMPUTED by running each row's sample through the engine, so
// these tests assert CONSISTENCY (a row says covered/partial if and only if its
// sample fires), never fixed statuses. The engine's rules land separately; when
// one lands, its row flips on its own and these tests stay green.

describe("threat-coverage matrix is self-checking", () => {
  it("has unique, well-formed entries", () => {
    const ids = THREAT_COVERAGE.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of THREAT_COVERAGE) {
      expect(e.name.length).toBeGreaterThan(3);
      expect(e.note.length).toBeGreaterThan(10);
      if (e.status === "covered" || e.status === "partial") expect(e.lenses.length).toBeGreaterThan(0);
      if (e.status === "not-agent-observable" || e.status === "gap") expect(e.lenses).toEqual([]);
    }
  });

  it("every agent-observable row carries a runnable sample, except the named no-check residual", () => {
    for (const sp of THREAT_SPECS) {
      if (sp.outOfScope) {
        expect(sp.check).toBeUndefined(); // code-level rows claim nothing
        continue;
      }
      if (sp.id === "LLM01-indirect-fence-coverage") continue; // honest gap: no guard exists to run
      expect(typeof sp.check).toBe("function");
      expect(sp.sample && sp.sample.length > 0).toBe(true);
    }
  });

  it("a row is covered/partial IF AND ONLY IF its sample fires in the engine", () => {
    for (const sp of THREAT_SPECS) {
      const row = THREAT_COVERAGE.find((e) => e.id === sp.id)!;
      if (sp.outOfScope) {
        expect(row.status).toBe("not-agent-observable");
        continue;
      }
      const earned = runThreatCheck(sp.check);
      expect({ id: sp.id, status: row.status }).toEqual({ id: sp.id, status: earned ?? "gap" });
    }
  });

  it("a row whose sample does not fire is reported as a gap, with the reason", () => {
    const fake: ThreatSpec[] = [
      { id: "X-FIRES", name: "fires", family: "agent-llm", lenses: ["payload"], note: "a note long enough", sample: "s", check: () => "covered" },
      { id: "X-MISS", name: "misses", family: "agent-llm", lenses: ["payload"], note: "a note long enough", sample: "/nope", check: () => null },
      { id: "X-THROWS", name: "throws", family: "agent-llm", lenses: ["payload"], note: "a note long enough", sample: "/boom", check: () => { throw new Error("x"); } },
      { id: "X-NOCHECK", name: "no check", family: "agent-llm", lenses: ["payload"], note: "a note long enough" },
    ];
    const [fires, miss, throws, nocheck] = evaluateCoverage(fake);
    expect(fires.status).toBe("covered");
    expect(miss).toMatchObject({ status: "gap", lenses: [] });
    expect(miss.note).toMatch(/did not fire.*\/nope/);
    expect(throws.status).toBe("gap"); // a crashing check is a gap, never a crash
    expect(nocheck.status).toBe("gap"); // claims nothing it cannot prove
  });

  it("includes this week's threats as rows", () => {
    for (const id of ["LLMJACKING", "NEXTJS-MIDDLEWARE-BYPASS", "PHP-CGI-INJECTION", "WP-PLUGIN-ABUSE", "FAST-AGENT", "CRAWLER-IMPERSONATION", "SECRET-FILES"]) {
      const row = THREAT_COVERAGE.find((e) => e.id === id);
      expect(row).toBeDefined();
      expect(row!.sample).toBeTruthy();
    }
  });

  // PARITY with the probe lens: every CWE the probe signatures label must be a
  // row on the probe-path lens, so the matrix cannot silently drop a probe class.
  it("every CWE the probe lens labels is in the matrix on the probe-path lens", () => {
    const probeCwes = Array.from(new Set(PROBE_SIGNATURES.map((s) => s.cwe)));
    for (const cwe of probeCwes) {
      const spec = THREAT_SPECS.find((e) => e.id === cwe);
      expect({ cwe, present: !!spec }).toEqual({ cwe, present: true });
      const lenses = spec!.lenses;
      // CWE-22 / CWE-78 are proven on the payload lens; the rest on probe-path.
      expect(lenses.includes("probe-path") || lenses.includes("payload")).toBe(true);
    }
  });

  it("code-level CWEs are not-agent-observable, not gaps", () => {
    for (const id of ["CWE-787", "CWE-125", "CWE-416", "CWE-352"]) {
      expect(THREAT_COVERAGE.find((e) => e.id === id)!.status).toBe("not-agent-observable");
    }
  });

  it("partial-only rows never claim covered (the honesty ceiling holds)", () => {
    // These rows can only ever earn partial: the inbound attempt is visible but
    // the real flaw is in the app (SAST / outbound-scan domain).
    for (const id of ["CWE-862", "CWE-863", "CWE-306", "CWE-287", "CWE-798", "CWE-20", "LLM02", "LLM01-indirect", "LLM06"]) {
      expect(THREAT_COVERAGE.find((e) => e.id === id)!.status).not.toBe("covered");
    }
  });

  it("is deterministic: evaluating twice gives the same matrix", () => {
    const a = evaluateCoverage().map((e) => `${e.id}:${e.status}`);
    const b = evaluateCoverage().map((e) => `${e.id}:${e.status}`);
    expect(a).toEqual(b);
  });
});

describe("coverageSummary", () => {
  it("counts by status and reports the honest observable-detected headline", () => {
    const s = coverageSummary();
    expect(s.total).toBe(THREAT_COVERAGE.length);
    expect(s.covered + s.partial + s.gap + s.notAgentObservable).toBe(s.total);
    expect(s.observableTotal).toBe(s.total - s.notAgentObservable);
    expect(s.observableDetected).toBe(s.covered + s.partial);
    expect(s.gaps.every((g: ThreatEntry) => g.status === "gap")).toBe(true);
    // The no-guard residual is always a named gap, so the list is never empty.
    expect(s.gaps.some((g) => g.id === "LLM01-indirect-fence-coverage")).toBe(true);
  });
});
