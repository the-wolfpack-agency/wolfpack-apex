/**
 * Tests for the benchmark scorer + active-learning signal extraction.
 *
 * Everything under test is pure; trackEvent is injected so analytics emission is
 * asserted deterministically (no DB, no clock). The cross-cutting invariant we
 * defend in nearly every case: precision/recall are ONLY trusted on labeled
 * targets, and "extra" classes are candidates, never confirmed false positives.
 */

import {
  scoreTarget,
  scoreBenchmark,
  extractLearningSignals,
  findingClassKey,
  defaultScorerDeps,
  NOISE_CANDIDATE_MIN_COUNT,
  type BenchmarkResult,
  type ScorerDeps,
  type BenchmarkReport,
} from "../scorer";
import type { ScanFinding } from "../../types";
import type { BenchmarkTarget } from "../corpus";

// --- fixtures --------------------------------------------------------------

function finding(category: ScanFinding["category"], title: string, route = "/"): ScanFinding {
  return {
    route,
    severity: "high",
    category,
    title,
    detail: `${category}:${title} on ${route}`,
    evidence: { status: 200 },
  };
}

function target(name: string, groundTruth?: BenchmarkTarget["groundTruth"]): BenchmarkTarget {
  return {
    name,
    baseUrl: `http://localhost/${name}`,
    provenance: "self-hosted-benchmark",
    activeAllowed: true,
    modality: ["http"],
    groundTruth,
    consentNote: "test fixture",
  };
}

/** A trackEvent spy with the deps shape the scorer expects. */
function makeDeps(): { deps: ScorerDeps; calls: Array<{ type: string; meta: Record<string, unknown> }> } {
  const calls: Array<{ type: string; meta: Record<string, unknown> }> = [];
  const deps: ScorerDeps = {
    trackEvent: ((type: string, _id: string, _role: string, meta: Record<string, unknown>) => {
      calls.push({ type, meta });
    }) as ScorerDeps["trackEvent"],
    actor: { id: "tester", role: "system" },
  };
  return { deps, calls };
}

// --- findingClassKey -------------------------------------------------------

describe("findingClassKey", () => {
  it("is `${category}:${title}` and matches ground-truth class form", () => {
    const f = finding("security", "CORS wildcard with credentials");
    expect(findingClassKey(f)).toBe("security:CORS wildcard with credentials");
  });

  it("is route-independent (a class spans routes)", () => {
    const a = finding("bug", "500 on submit", "/a");
    const b = finding("bug", "500 on submit", "/b");
    expect(findingClassKey(a)).toBe(findingClassKey(b));
  });
});

// --- scoreTarget -----------------------------------------------------------

describe("scoreTarget", () => {
  it("all ground truth found -> recall 1, nothing missed, labeled true", () => {
    const t = target("t1", [
      { findingClass: "security:SQLi" },
      { findingClass: "security:XSS" },
    ]);
    const findings = [finding("security", "SQLi"), finding("security", "XSS")];

    const score = scoreTarget(t, findings);

    expect(score.labeled).toBe(true);
    expect(score.recall).toBe(1);
    expect(score.matched.sort()).toEqual(["security:SQLi", "security:XSS"]);
    expect(score.missed).toEqual([]);
    expect(score.extra).toEqual([]);
  });

  it("some missed -> listed as coverage gaps and recall < 1", () => {
    const t = target("t2", [
      { findingClass: "security:SQLi" },
      { findingClass: "security:XSS" },
      { findingClass: "bug:500 on submit" },
    ]);
    const findings = [finding("security", "SQLi")];

    const score = scoreTarget(t, findings);

    expect(score.matched).toEqual(["security:SQLi"]);
    expect(score.missed).toEqual(["bug:500 on submit", "security:XSS"]);
    expect(score.recall).toBeCloseTo(1 / 3);
    expect(score.labeled).toBe(true);
  });

  it("an extra (non-ground-truth) class -> appears in extra with its count", () => {
    const t = target("t3", [{ findingClass: "security:SQLi" }]);
    const findings = [
      finding("security", "SQLi"),
      finding("ux_gap", "no empty state", "/x"),
      finding("ux_gap", "no empty state", "/y"), // same class, 2 routes
    ];

    const score = scoreTarget(t, findings);

    expect(score.matched).toEqual(["security:SQLi"]);
    expect(score.extra).toEqual([{ findingClass: "ux_gap:no empty state", count: 2 }]);
  });

  it("unlabeled target -> labeled false, recall null (n/a, NOT a vacuous 1), extras still listed but untrustworthy", () => {
    const t = target("unlabeled"); // no groundTruth
    const findings = [finding("bug", "broken link"), finding("bug", "broken link", "/2")];

    const score = scoreTarget(t, findings);

    expect(score.labeled).toBe(false);
    // FIX #2: recall is null (not applicable), never 1 - a vacuous 1 reads as "100%"
    // to a client. There is no ground truth to measure recall against.
    expect(score.recall).toBeNull();
    expect(score.missed).toEqual([]);
    // Extras are still surfaced so no data is lost, but labeled:false flags them
    // as untrustworthy (could be genuinely unlabeled real findings).
    expect(score.extra).toEqual([{ findingClass: "bug:broken link", count: 2 }]);
  });

  it("empty groundTruth array is treated as unlabeled (recall null, never 1)", () => {
    const t = target("emptyGT", []);
    const score = scoreTarget(t, [finding("bug", "x")]);
    expect(score.labeled).toBe(false);
    expect(score.recall).toBeNull();
  });

  it("no findings against labeled target -> recall 0, all missed", () => {
    const t = target("silent", [{ findingClass: "security:SQLi" }]);
    const score = scoreTarget(t, []);
    expect(score.recall).toBe(0);
    expect(score.missed).toEqual(["security:SQLi"]);
    expect(score.matched).toEqual([]);
  });
});

// --- scoreBenchmark --------------------------------------------------------

describe("scoreBenchmark", () => {
  it("aggregates recall/precision over LABELED targets only", () => {
    const labeled = target("lab", [
      { findingClass: "security:SQLi" },
      { findingClass: "security:XSS" },
    ]);
    const unlabeled = target("unlab"); // its extras must NOT pollute precision
    const results: BenchmarkResult[] = [
      { target: labeled, findings: [finding("security", "SQLi"), finding("ux_gap", "noise")] },
      { target: unlabeled, findings: [finding("bug", "tons"), finding("bug", "of"), finding("bug", "extras")] },
    ];
    const { deps } = makeDeps();

    const report = scoreBenchmark(results, deps);

    // labeled target: matched 1 of 2 truth -> recall 0.5
    expect(report.recall).toBe(0.5);
    // precision = matched / (matched + extra-on-labeled) = 1 / (1 + 1) = 0.5
    expect(report.precision).toBe(0.5);
    expect(report.labeledTargets).toBe(1);
  });

  it("coverageClasses is the union of distinct classes across ALL targets", () => {
    const results: BenchmarkResult[] = [
      { target: target("a", [{ findingClass: "security:SQLi" }]), findings: [finding("security", "SQLi")] },
      { target: target("b"), findings: [finding("bug", "z"), finding("bug", "z", "/2")] },
    ];
    const { deps } = makeDeps();

    const report = scoreBenchmark(results, deps);

    expect(report.coverageClasses).toEqual(["bug:z", "security:SQLi"]);
  });

  it("counts errored targets (robustness)", () => {
    const results: BenchmarkResult[] = [
      { target: target("ok", [{ findingClass: "security:SQLi" }]), findings: [finding("security", "SQLi")] },
      { target: target("down"), findings: [], errored: true },
    ];
    const { deps } = makeDeps();

    const report = scoreBenchmark(results, deps);

    expect(report.erroredCount).toBe(1);
    expect(report.targets).toBe(2);
  });

  it("fires platform.benchmark_run exactly once with the right shape", () => {
    const results: BenchmarkResult[] = [
      { target: target("a", [{ findingClass: "security:SQLi" }]), findings: [finding("security", "SQLi")] },
      { target: target("b"), findings: [finding("bug", "z")], errored: true },
    ];
    const { deps, calls } = makeDeps();

    scoreBenchmark(results, deps);

    const runs = calls.filter((c) => c.type === "platform.benchmark_run");
    expect(runs).toHaveLength(1);
    expect(runs[0].meta).toEqual({
      targets: 2,
      recall: 1,
      precision: 1,
      coverage_classes: 2,
      errored: 1,
    });
  });

  it("empty results -> n/a metrics (null, not vacuous 1), no crash, event still fired", () => {
    const { deps, calls } = makeDeps();
    const report = scoreBenchmark([], deps);

    expect(report.targets).toBe(0);
    // FIX #2: no labeled targets -> recall/precision are null (n/a), never 1.
    expect(report.recall).toBeNull();
    expect(report.precision).toBeNull();
    expect(report.coverageClasses).toEqual([]);
    expect(report.labeledTargets).toBe(0);
    expect(calls.filter((c) => c.type === "platform.benchmark_run")).toHaveLength(1);
  });

  it("no labeled targets -> metrics null (n/a) and labeledTargets 0 (not a fabricated 100%)", () => {
    const results: BenchmarkResult[] = [
      { target: target("u1"), findings: [finding("bug", "a")] },
      { target: target("u2"), findings: [finding("bug", "b")] },
    ];
    const { deps } = makeDeps();
    const report = scoreBenchmark(results, deps);
    // FIX #2: own/unlabeled apps no longer show "100%, perfect" - they show n/a.
    expect(report.recall).toBeNull();
    expect(report.precision).toBeNull();
    expect(report.labeledTargets).toBe(0);
  });

  it("FIX #2 negative: unlabeled extras never inflate a null aggregate to a real number", () => {
    // A target with no ground truth but many findings must NOT push recall/precision
    // off null - there is nothing to score, so the dashboard shows n/a, not 100%.
    const noisy = Array.from({ length: 9 }, (_, i) => finding("bug", `b${i}`, `/r${i}`));
    const { deps } = makeDeps();
    const report = scoreBenchmark([{ target: target("ownApp"), findings: noisy }], deps);
    expect(report.recall).toBeNull();
    expect(report.precision).toBeNull();
    expect(report.labeledTargets).toBe(0);
    // The findings are still counted as coverage breadth (no data lost).
    expect(report.coverageClasses.length).toBe(9);
  });
});

// --- extractLearningSignals ------------------------------------------------

describe("extractLearningSignals", () => {
  function reportFrom(results: BenchmarkResult[]): { report: BenchmarkReport; calls: ReturnType<typeof makeDeps>["calls"] } {
    const { deps, calls } = makeDeps();
    const report = scoreBenchmark(results, deps);
    // Drop the benchmark_run call so signal assertions are clean.
    calls.length = 0;
    return { report, calls };
  }

  it("a missed labeled class -> one coverage_gap signal, emitted", () => {
    const t = target("t", [{ findingClass: "security:SQLi" }, { findingClass: "security:XSS" }]);
    const { report } = reportFrom([{ target: t, findings: [finding("security", "SQLi")] }]);
    const { deps, calls } = makeDeps();

    const signals = extractLearningSignals(report, deps);

    const gaps = signals.filter((s) => s.kind === "coverage_gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].findingClass).toBe("security:XSS");

    const emitted = calls.filter((c) => c.type === "platform.learning_signal_detected");
    expect(emitted).toHaveLength(1);
    expect(emitted[0].meta).toMatchObject({ kind: "coverage_gap", finding_class: "security:XSS" });
  });

  it("a high-frequency labeled-but-untruthed class -> one noise_candidate signal", () => {
    // 'ux_gap:noisy' fires NOISE_CANDIDATE_MIN_COUNT times on a labeled target,
    // and is in NO ground truth -> noise candidate.
    const routes = Array.from({ length: NOISE_CANDIDATE_MIN_COUNT }, (_, i) => finding("ux_gap", "noisy", `/r${i}`));
    const t = target("t", [{ findingClass: "security:SQLi" }]);
    const { report } = reportFrom([{ target: t, findings: [finding("security", "SQLi"), ...routes] }]);
    const { deps, calls } = makeDeps();

    const signals = extractLearningSignals(report, deps);

    const noise = signals.filter((s) => s.kind === "noise_candidate");
    expect(noise).toHaveLength(1);
    expect(noise[0].findingClass).toBe("ux_gap:noisy");
    expect(calls.filter((c) => c.type === "platform.learning_signal_detected")).toHaveLength(signals.length);
  });

  it("a low-frequency extra is NOT a noise candidate", () => {
    const t = target("t", [{ findingClass: "security:SQLi" }]);
    // only 1 occurrence, below threshold
    const { report } = reportFrom([{ target: t, findings: [finding("security", "SQLi"), finding("ux_gap", "rare")] }]);
    const { deps } = makeDeps();

    const signals = extractLearningSignals(report, deps);
    expect(signals.filter((s) => s.kind === "noise_candidate")).toHaveLength(0);
  });

  it("extras on UNLABELED targets are never noise candidates (could be unlabeled real findings)", () => {
    const routes = Array.from({ length: NOISE_CANDIDATE_MIN_COUNT + 2 }, (_, i) => finding("bug", "lots", `/r${i}`));
    const { report } = reportFrom([{ target: target("unlab"), findings: routes }]);
    const { deps } = makeDeps();

    const signals = extractLearningSignals(report, deps);
    expect(signals).toEqual([]);
  });

  it("fires one analytics event per signal (no data lost)", () => {
    const t = target("t", [{ findingClass: "security:SQLi" }, { findingClass: "security:XSS" }]);
    const noise = Array.from({ length: NOISE_CANDIDATE_MIN_COUNT }, (_, i) => finding("ux_gap", "noisy", `/r${i}`));
    const { report } = reportFrom([{ target: t, findings: [finding("security", "SQLi"), ...noise] }]);
    const { deps, calls } = makeDeps();

    const signals = extractLearningSignals(report, deps);

    // 1 coverage_gap (XSS missed) + 1 noise_candidate (ux_gap:noisy)
    expect(signals.map((s) => s.kind).sort()).toEqual(["coverage_gap", "noise_candidate"]);
    expect(calls.filter((c) => c.type === "platform.learning_signal_detected")).toHaveLength(2);
  });

  it("a class missed on multiple labeled targets dedupes to a single coverage_gap", () => {
    const gt = [{ findingClass: "security:XSS" }];
    const { report } = reportFrom([
      { target: target("a", gt), findings: [] },
      { target: target("b", gt), findings: [] },
    ]);
    const { deps } = makeDeps();

    const signals = extractLearningSignals(report, deps);
    const gaps = signals.filter((s) => s.kind === "coverage_gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].detail).toContain("2 labeled targets");
  });

  it("empty report -> no signals, no events", () => {
    const { report } = reportFrom([]);
    const { deps, calls } = makeDeps();
    const signals = extractLearningSignals(report, deps);
    expect(signals).toEqual([]);
    expect(calls).toEqual([]);
  });
});

// --- defaults --------------------------------------------------------------

describe("default deps", () => {
  it("default actor is the unattended system actor", () => {
    expect(defaultScorerDeps.actor).toEqual({ id: "system", role: "system" });
    expect(typeof defaultScorerDeps.trackEvent).toBe("function");
  });
});
