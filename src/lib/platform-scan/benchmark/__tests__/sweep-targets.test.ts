/**
 * The continuous benchmark sweep's target-selection is a SAFETY surface: it must
 * scan ONLY consent-corpus targets and ONLY in read-only mode. These tests pin
 * that contract: every real corpus target passes the read-only gate (so the sweep
 * covers the whole allowlist), and a hypothetical non-corpus entry is refused and
 * excluded (the open internet is never swept). The sweep CLI is thin; this is where
 * its load-bearing logic is verified, with no browser or network.
 */
import {
  selectReadOnlyTargets,
  DEFAULT_SWEEP_ROUTES,
} from "@/lib/platform-scan/benchmark/sweep-targets";
import {
  BENCHMARK_CORPUS,
  type BenchmarkTarget,
} from "@/lib/platform-scan/benchmark/corpus";

describe("selectReadOnlyTargets (continuous benchmark sweep)", () => {
  it("selects every corpus target for read-only sweeping and skips none", () => {
    const { selected, skipped } = selectReadOnlyTargets();
    expect(selected).toHaveLength(BENCHMARK_CORPUS.length);
    expect(selected.map((t) => t.name).sort()).toEqual(
      BENCHMARK_CORPUS.map((t) => t.name).sort(),
    );
    expect(skipped).toHaveLength(0);
  });

  it("defaults to the full corpus when no argument is passed", () => {
    expect(selectReadOnlyTargets().selected.map((t) => t.name)).toEqual(
      selectReadOnlyTargets(BENCHMARK_CORPUS).selected.map((t) => t.name),
    );
  });

  it("EXCLUDES a hypothetical non-corpus entry (the open internet is never swept)", () => {
    const rogue: BenchmarkTarget = {
      name: "rogue-not-in-corpus.example.com",
      baseUrl: "https://rogue-not-in-corpus.example.com",
      provenance: "opt-in",
      activeAllowed: false,
      modality: ["http"],
      consentNote: "NOT a real corpus entry; fabricated for this test only.",
    };
    const { selected, skipped } = selectReadOnlyTargets([rogue]);
    expect(selected).toHaveLength(0);
    expect(skipped).toEqual([
      { name: rogue.name, reason: "not_in_corpus" },
    ]);
  });

  it("scans real corpus targets even alongside a rogue entry (per-target isolation)", () => {
    const real = BENCHMARK_CORPUS[0];
    const rogue: BenchmarkTarget = {
      name: "rogue.example.com",
      baseUrl: "https://rogue.example.com",
      provenance: "opt-in",
      activeAllowed: false,
      modality: ["http"],
      consentNote: "fabricated, not in corpus.",
    };
    const { selected, skipped } = selectReadOnlyTargets([real, rogue]);
    expect(selected.map((t) => t.name)).toEqual([real.name]);
    expect(skipped.map((s) => s.name)).toEqual([rogue.name]);
  });

  it("exposes a non-empty default route set for targets without an explicit list", () => {
    expect(DEFAULT_SWEEP_ROUTES.length).toBeGreaterThan(0);
    for (const r of DEFAULT_SWEEP_ROUTES) {
      expect(typeof r.path).toBe("string");
      expect(r.path.startsWith("/")).toBe(true);
      expect(typeof r.journey).toBe("string");
      expect(r.journey.length).toBeGreaterThan(0);
    }
  });
});
