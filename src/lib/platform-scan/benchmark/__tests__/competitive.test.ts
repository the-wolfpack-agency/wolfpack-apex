/**
 * Unit tests for the competitive benchmark core (competitive.ts).
 *
 * Proves, against the REAL scorer + a real corpus target:
 *   - normalizeCompetitorFindings maps ZAP alert names AND Nuclei template ids/tags
 *     into OUR `${category}:${title}` taxonomy; unmapped findings pass through under
 *     a competitor: class (kept as coverage, never a ground-truth match).
 *   - scoreCompetitor produces recall vs the target's ground truth via the scorer.
 *   - buildCompetitiveReport emits platform.competitor_gap_detected for rival-only
 *     classes and platform.competitive_parity_confirmed when we match/beat all tools.
 *   - improvementTrend computes latest-vs-prior deltas incl. the first-run/no-prior
 *     edge, and orders the sparkline series oldest-first.
 *
 * trackEvent is INJECTED so no analytics is emitted; assertions are deterministic.
 */

import { findingClassKey } from "../scorer";
import { getBenchmarkTarget } from "../corpus";
import {
  normalizeCompetitorFindings,
  scoreCompetitor,
  buildCompetitiveReport,
  improvementTrend,
  precisionOf,
  type CompetitiveDeps,
  type OurTargetScore,
} from "../competitive";
import type { BenchmarkRunRow } from "../benchmark-store";

const JUICE = getBenchmarkTarget("self-hosted-juice-shop")!;
const VAMPI = getBenchmarkTarget("vampi")!;

function mkDeps(): { deps: CompetitiveDeps; events: unknown[][] } {
  const events: unknown[][] = [];
  const deps: CompetitiveDeps = {
    trackEvent: ((...args: unknown[]) => {
      events.push(args);
    }) as CompetitiveDeps["trackEvent"],
    actor: { id: "system", role: "system" },
  };
  return { deps, events };
}

describe("normalizeCompetitorFindings", () => {
  test("maps ZAP alert names into our category:title taxonomy", () => {
    const out = normalizeCompetitorFindings("zap", [
      { alert: "SQL Injection", url: "/rest/user/login" },
      { alert: "Cross Site Scripting (Reflected)", url: "/search?q=x" },
      { alert: "Cross-Domain Misconfiguration", url: "/rest" },
    ]);
    const classes = out.map(findingClassKey);
    expect(classes).toContain("security:SQL injection");
    expect(classes).toContain("security:Reflected XSS");
    expect(classes).toContain("security:CORS wildcard with credentials");
  });

  test("maps Nuclei template ids AND tags into our taxonomy", () => {
    const out = normalizeCompetitorFindings("nuclei", [
      { templateId: "generic-sqli", "matched-at": "https://t/api" },
      { templateId: "cve-2021-x", tags: ["xss", "cve"], "matched-at": "https://t/s" },
      { templateId: "exposed-data", tags: "exposure" },
    ]);
    const classes = out.map(findingClassKey);
    expect(classes).toContain("security:SQL injection");
    expect(classes).toContain("security:Reflected XSS");
    expect(classes).toContain("security:Excessive data exposure");
  });

  test("unmapped findings pass through honestly as a competitor: class (coverage, not a GT match)", () => {
    const out = normalizeCompetitorFindings("zap", [
      { alert: "Some Informational Banner Disclosure", url: "/" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toMatch(/^competitor:zap:/);
    expect(out[0].evidence.unmapped).toBe(true);
    // It cannot collide with any ground-truth class.
    expect(JUICE.groundTruth!.some((g) => g.findingClass === findingClassKey(out[0]))).toBe(false);
  });

  test("skips entries with no native identity", () => {
    expect(normalizeCompetitorFindings("zap", [{ url: "/x" } as never])).toHaveLength(0);
    expect(normalizeCompetitorFindings("nuclei", [{} as never])).toHaveLength(0);
  });
});

describe("scoreCompetitor (recall vs ground truth via the scorer)", () => {
  test("honesty: a generic ZAP SQLi is NOT auto-credited as a juice-shop-specific GT class", () => {
    // juice-shop GT uses juice-shop:* classes (e.g. "juice-shop:SQL injection
    // (login bypass)"). Our conservative normalize maps a generic ZAP "SQL
    // Injection" to security:SQL injection, which intentionally does NOT match the
    // juice-shop-specific class. Recall is therefore 0 here, and that is the honest
    // result: we never inflate a rival's recall by loose mapping. The CORS class on
    // juice-shop DOES use our security: convention, so that one can match.
    const findings = normalizeCompetitorFindings("zap", [
      { alert: "SQL Injection", url: "/rest/user/login" },
      { alert: "Cross-Domain Misconfiguration", url: "/rest" },
    ]);
    const result = scoreCompetitor("zap", JUICE, findings);
    expect(result.tool).toBe("zap");
    expect(result.target).toBe(JUICE.name);
    // Only the security:CORS class matches the juice-shop GT; the generic SQLi does not.
    expect(result.score.matched).toEqual(["security:CORS wildcard with credentials"]);
    expect(result.score.recall).toBeCloseTo(1 / JUICE.groundTruth!.length, 5);
  });

  test("matches a security: ground-truth class on a target labeled with security: classes (vampi)", () => {
    // VAmPI GT uses security:* classes that our normalize produces directly.
    const findings = normalizeCompetitorFindings("nuclei", [
      { templateId: "sqli-error-based", "matched-at": "https://t/users" },
      { templateId: "idor-check", "matched-at": "https://t/users/v1" },
    ]);
    const result = scoreCompetitor("nuclei", VAMPI, findings);
    expect(result.score.matched).toEqual(
      expect.arrayContaining([
        "security:SQL injection",
        "security:Broken object level authorization (IDOR)",
      ]),
    );
    // 2 matched out of VAmPI's 5 GT classes.
    expect(result.score.recall).toBeCloseTo(2 / VAMPI.groundTruth!.length, 5);
  });
});

describe("buildCompetitiveReport", () => {
  function vampiScore(tool: "zap" | "nuclei", templates: { templateId?: string; alert?: string }[]) {
    const findings = normalizeCompetitorFindings(
      tool,
      templates.map((t) => ({ ...t, "matched-at": "https://t/x" })),
    );
    return scoreCompetitor(tool, VAMPI, findings);
  }

  test("emits competitor_gap_detected for a class the rival caught that we missed", () => {
    const { deps, events } = mkDeps();
    // We matched only SQLi; rival (nuclei) also caught IDOR -> rival-only gap.
    const ours: OurTargetScore = {
      target: VAMPI.name,
      recall: 0.2,
      precision: 1,
      matched: ["security:SQL injection"],
    };
    const nuclei = vampiScore("nuclei", [
      { templateId: "sqli" },
      { templateId: "idor" },
    ]);
    const report = buildCompetitiveReport(ours, [nuclei], deps);

    expect(report.rivalOnlyGaps).toEqual([
      { findingClass: "security:Broken object level authorization (IDOR)", tools: ["nuclei"] },
    ]);
    expect(report.parity).toBe(false);

    const gapEvents = events.filter((e) => e[0] === "platform.competitor_gap_detected");
    expect(gapEvents).toHaveLength(1);
    expect(gapEvents[0][3]).toMatchObject({
      tool: "nuclei",
      target: VAMPI.name,
      finding_class: "security:Broken object level authorization (IDOR)",
    });
    // No parity event when there is a rival-only gap.
    expect(events.some((e) => e[0] === "platform.competitive_parity_confirmed")).toBe(false);
  });

  test("emits competitive_parity_confirmed when we match/beat every tool", () => {
    const { deps, events } = mkDeps();
    // We matched both SQLi + IDOR; rival caught only SQLi -> no rival-only class.
    const ours: OurTargetScore = {
      target: VAMPI.name,
      recall: 0.4,
      precision: 1,
      matched: [
        "security:SQL injection",
        "security:Broken object level authorization (IDOR)",
      ],
    };
    const nuclei = vampiScore("nuclei", [{ templateId: "sqli" }]);
    const report = buildCompetitiveReport(ours, [nuclei], deps);

    expect(report.rivalOnlyGaps).toEqual([]);
    expect(report.parity).toBe(true);
    const parityEvents = events.filter((e) => e[0] === "platform.competitive_parity_confirmed");
    expect(parityEvents).toHaveLength(1);
    expect(parityEvents[0][3]).toMatchObject({ target: VAMPI.name, tools_compared: 1 });
  });

  test("accumulates which tools caught a rival-only class across multiple tools", () => {
    const { deps } = mkDeps();
    const ours: OurTargetScore = { target: VAMPI.name, recall: 0, precision: 1, matched: [] };
    const zap = vampiScore("zap", [{ alert: "SQL Injection" }]);
    const nuclei = vampiScore("nuclei", [{ templateId: "sqli" }]);
    const report = buildCompetitiveReport(ours, [zap, nuclei], deps);
    const sqli = report.rivalOnlyGaps.find((g) => g.findingClass === "security:SQL injection");
    expect(sqli?.tools).toEqual(["nuclei", "zap"]);
  });

  test("no parity (and no parity event) when zero tools were compared", () => {
    const { deps, events } = mkDeps();
    const ours: OurTargetScore = { target: VAMPI.name, recall: 1, precision: 1, matched: [] };
    const report = buildCompetitiveReport(ours, [], deps);
    expect(report.parity).toBe(false);
    expect(events).toHaveLength(0);
  });

  test("per-tool head-to-head carries recall + precision laid next to ours", () => {
    const { deps } = mkDeps();
    const ours: OurTargetScore = { target: VAMPI.name, recall: 0.6, precision: 0.9, matched: [] };
    const nuclei = vampiScore("nuclei", [{ templateId: "sqli" }]);
    const report = buildCompetitiveReport(ours, [nuclei], deps);
    expect(report.ours).toEqual({ recall: 0.6, precision: 0.9, matched: [] });
    expect(report.tools[0]).toMatchObject({
      tool: "nuclei",
      label: "Nuclei",
      recall: nuclei.score.recall,
      precision: precisionOf(nuclei.score),
    });
  });
});

describe("improvementTrend", () => {
  function run(recall: number, coverage: number, runAt: string): BenchmarkRunRow {
    return {
      id: `r_${runAt}`,
      runAt,
      targets: 5,
      labeledTargets: 3,
      recall,
      precision: 1,
      coverageClasses: coverage,
      errored: 0,
      report: {} as BenchmarkRunRow["report"],
      signals: [],
    };
  }

  test("computes latest-vs-prior recall + coverage deltas (newest-first input)", () => {
    const runs = [
      run(0.8, 12, "2026-06-28T00:00:00.000Z"), // latest
      run(0.5, 9, "2026-06-21T00:00:00.000Z"), // prior
      run(0.4, 7, "2026-06-14T00:00:00.000Z"),
    ];
    const t = improvementTrend(runs);
    expect(t.latestRecall).toBeCloseTo(0.8, 5);
    expect(t.recallDelta).toBeCloseTo(0.3, 5);
    expect(t.coverageDelta).toBe(3);
    expect(t.hasPrior).toBe(true);
    // Series is oldest-first for the sparkline.
    expect(t.series.map((p) => p.recall)).toEqual([0.4, 0.5, 0.8]);
  });

  test("first-run / no-prior edge: deltas are 0 and hasPrior is false", () => {
    const t = improvementTrend([run(0.6, 10, "2026-06-28T00:00:00.000Z")]);
    expect(t.latestRecall).toBeCloseTo(0.6, 5);
    expect(t.recallDelta).toBe(0);
    expect(t.coverageDelta).toBe(0);
    expect(t.hasPrior).toBe(false);
    expect(t.series).toHaveLength(1);
  });

  test("empty input degrades to a zeroed trend (never throws)", () => {
    const t = improvementTrend([]);
    expect(t).toEqual({ series: [], latestRecall: 0, recallDelta: 0, coverageDelta: 0, hasPrior: false });
  });
});
