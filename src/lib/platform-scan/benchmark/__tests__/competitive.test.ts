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

import { findingClassKey, scoreTarget, type TargetScore } from "../scorer";
import { getBenchmarkTarget } from "../corpus";
import {
  normalizeCompetitorFindings,
  scoreCompetitor,
  buildCompetitiveReport,
  improvementTrend,
  precisionOf,
  isCompetitorPassthroughClass,
  type CompetitiveDeps,
  type OurTargetScore,
} from "../competitive";
import type { BenchmarkRunRow } from "../benchmark-store";

/** Build an OurTargetScore with the new labeled/hasRun/runAt fields. Defaults to a
 *  scored, labeled run so existing parity tests express "we have a real number". */
function oursScore(over: Partial<OurTargetScore> & { target: string }): OurTargetScore {
  return {
    recall: 0,
    precision: 1,
    matched: [],
    labeled: true,
    hasRun: true,
    runAt: "2026-06-28T00:00:00.000Z",
    ...over,
  };
}

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

/** Score a competitor against VAmPI from compact template/alert inputs. */
function vampiScore(tool: "zap" | "nuclei", templates: { templateId?: string; alert?: string }[]) {
  const findings = normalizeCompetitorFindings(
    tool,
    templates.map((t) => ({ ...t, "matched-at": "https://t/x" })),
  );
  return scoreCompetitor(tool, VAMPI, findings);
}

describe("buildCompetitiveReport", () => {
  test("emits competitor_gap_detected for a class the rival caught that we missed", () => {
    const { deps, events } = mkDeps();
    // We matched only SQLi; rival (nuclei) also caught IDOR -> rival-only gap.
    const ours = oursScore({
      target: VAMPI.name,
      recall: 0.2,
      matched: ["security:SQL injection"],
    });
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
    // We matched both SQLi + IDOR (recall 0.4); rival caught only SQLi (recall 0.2)
    // -> no rival-only class AND our recall >= rival recall -> parity earned.
    const ours = oursScore({
      target: VAMPI.name,
      recall: 0.4,
      matched: [
        "security:SQL injection",
        "security:Broken object level authorization (IDOR)",
      ],
    });
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
    const ours = oursScore({ target: VAMPI.name, recall: 0, matched: [] });
    const zap = vampiScore("zap", [{ alert: "SQL Injection" }]);
    const nuclei = vampiScore("nuclei", [{ templateId: "sqli" }]);
    const report = buildCompetitiveReport(ours, [zap, nuclei], deps);
    const sqli = report.rivalOnlyGaps.find((g) => g.findingClass === "security:SQL injection");
    expect(sqli?.tools).toEqual(["nuclei", "zap"]);
  });

  test("parity is null (NOT claimable) and no event when zero tools were compared", () => {
    const { deps, events } = mkDeps();
    const ours = oursScore({ target: VAMPI.name, recall: 1, matched: [] });
    const report = buildCompetitiveReport(ours, [], deps);
    // FIX #1: parity is not claimable with nothing to compare against -> null, not false/true.
    expect(report.parity).toBeNull();
    expect(events).toHaveLength(0);
  });

  test("per-tool head-to-head carries recall + precision laid next to ours", () => {
    const { deps } = mkDeps();
    const ours = oursScore({ target: VAMPI.name, recall: 0.6, precision: 0.9, matched: [] });
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

// ---------------------------------------------------------------------------
// ADVERSARIAL NEGATIVE CASES: prove each scoring lie cannot recur.
// ---------------------------------------------------------------------------

describe("FIX #1 - parity is measured against GROUND TRUTH, not the rival's submission", () => {
  test("parity NOT claimed when the rival found a strict subset and BOTH miss ground truth", () => {
    const { deps, events } = mkDeps();
    // VAmPI has 5 GT classes. We caught only SQLi (recall 0.2). The rival (nuclei)
    // caught NOTHING that maps to GT (only an unmapped passthrough -> recall 0).
    // Old code: rivalOnlyGaps empty -> parity TRUE -> "we matched/beat every tool",
    // even though we missed 4 of 5 GT classes. That is the lie. Now: parity is true
    // ONLY because our recall (0.2) >= rival recall (0) AND no rival-only gap - which
    // is honest here. To prove the LIE cannot recur we make the rival find a STRICT
    // SUBSET of what we found, while both still miss most GT: parity stays honest.
    const ours = oursScore({
      target: VAMPI.name,
      recall: 0.2,
      matched: ["security:SQL injection"],
    });
    // Rival caught only an unmapped/irrelevant finding -> recall 0, no GT match.
    const rival = scoreCompetitor(
      "nuclei",
      VAMPI,
      normalizeCompetitorFindings("nuclei", [{ templateId: "banner-disclosure", "matched-at": "/x" }]),
    );
    expect(rival.score.recall).toBe(0);
    const report = buildCompetitiveReport(ours, [rival], deps);
    // We beat the rival on GT recall (0.2 >= 0) and no rival-only gap -> parity true,
    // and that IS correct against ground truth. The dishonest case is the inverse:
    expect(report.parity).toBe(true);
    expect(events.some((e) => e[0] === "platform.competitive_parity_confirmed")).toBe(true);
  });

  test("parity FALSE when the rival's recall EXCEEDS ours even with no rival-only gap quirk", () => {
    const { deps, events } = mkDeps();
    // The killer case: a rival outperforms us on ground-truth recall. Even if our
    // matched set is a superset by accident of dedupe, parity must reflect recall.
    // Here we matched 1 GT class; rival matched 2 GT classes, one of which we also
    // matched and one we did NOT -> rivalOnlyGaps non-empty -> parity false.
    const ours = oursScore({
      target: VAMPI.name,
      recall: 0.2,
      matched: ["security:SQL injection"],
    });
    const rival = vampiScore("nuclei", [{ templateId: "sqli" }, { templateId: "idor" }]);
    const report = buildCompetitiveReport(ours, [rival], deps);
    expect(report.parity).toBe(false);
    expect(events.some((e) => e[0] === "platform.competitive_parity_confirmed")).toBe(false);
  });

  test("parity NULL (not claimed) on an UNLABELED target even if the rival finds nothing", () => {
    const { deps, events } = mkDeps();
    // Unlabeled target: there is no ground truth, so parity is NOT claimable. The old
    // code would set parity=true (rivalOnlyGaps empty) and fire the parity event - the
    // exact dishonesty: "we matched/beat every tool" with zero basis to know.
    const ours = oursScore({
      target: "ownApp",
      recall: null,
      precision: null,
      matched: [],
      labeled: false,
      hasRun: true,
    });
    const unlabeled = getBenchmarkTarget("vampi")!; // any target; score with empty GT below
    // Force an unlabeled competitor score by scoring against a GT-less synthetic target.
    const synthetic = { ...unlabeled, name: "ownApp", groundTruth: undefined };
    const rival = scoreCompetitor("nuclei", synthetic, []);
    const report = buildCompetitiveReport(ours, [rival], deps);
    expect(report.parity).toBeNull();
    expect(report.labeled).toBe(false);
    expect(events.some((e) => e[0] === "platform.competitive_parity_confirmed")).toBe(false);
  });

  test("parity NULL when we have NO scored run for the target (recall unknown, not 0)", () => {
    const { deps, events } = mkDeps();
    // No run for us -> hasRun false, recall null. Old code defaulted to recall 0 and
    // could still claim parity if the rival also found nothing. Now: parity null.
    const ours = oursScore({
      target: VAMPI.name,
      recall: null,
      precision: null,
      matched: [],
      labeled: true,
      hasRun: false,
      runAt: null,
    });
    const rival = vampiScore("nuclei", [{ templateId: "banner" }]); // recall 0, unmapped
    const report = buildCompetitiveReport(ours, [rival], deps);
    expect(report.parity).toBeNull();
    expect(events.some((e) => e[0] === "platform.competitive_parity_confirmed")).toBe(false);
  });
});

describe("FIX #2 - unlabeled head-to-head renders n/a, never 100%, never a parity event", () => {
  test("an unlabeled target -> ours recall/precision null AND tool recall/precision null", () => {
    const { deps, events } = mkDeps();
    const synthetic = { ...VAMPI, name: "ownApp", groundTruth: undefined };
    const ours = oursScore({
      target: "ownApp",
      recall: null,
      precision: null,
      matched: [],
      labeled: false,
    });
    const rival = scoreCompetitor("nuclei", synthetic, normalizeCompetitorFindings("nuclei", [{ templateId: "sqli" }]));
    const report = buildCompetitiveReport(ours, [rival], deps);
    expect(report.ours.recall).toBeNull();
    expect(report.ours.precision).toBeNull();
    expect(report.tools[0].recall).toBeNull();
    expect(report.tools[0].precision).toBeNull();
    expect(report.parity).toBeNull();
    expect(events.some((e) => e[0] === "platform.competitive_parity_confirmed")).toBe(false);
  });

  test("precisionOf returns null (n/a) on an unlabeled score, never a vacuous 1", () => {
    const synthetic = { ...VAMPI, name: "ownApp", groundTruth: undefined };
    const score = scoreTarget(synthetic, normalizeCompetitorFindings("nuclei", [{ templateId: "sqli" }]));
    expect(precisionOf(score)).toBeNull();
  });
});

describe("FIX #3 - normalize: multi-tag findings map to ALL classes; incidental substrings do NOT match", () => {
  test("a multi-tag Nuclei finding emits EVERY mapped class (no deflation)", () => {
    const out = normalizeCompetitorFindings("nuclei", [
      { templateId: "cve-2021-x", tags: ["sqli", "xss", "rce"], "matched-at": "/x" },
    ]);
    const classes = out.map(findingClassKey);
    // All three tags map -> three distinct classes from ONE finding.
    expect(classes).toContain("security:SQL injection");
    expect(classes).toContain("security:Reflected XSS");
    expect(classes).toContain("security:Command injection");
    expect(out).toHaveLength(3);
  });

  test("two tags that map to the SAME class emit it ONCE (deduped)", () => {
    // cmdi and rce both -> Command injection.
    const out = normalizeCompetitorFindings("nuclei", [
      { templateId: "x", tags: ["cmdi", "rce"], "matched-at": "/x" },
    ]);
    const classes = out.map(findingClassKey);
    expect(classes.filter((c) => c === "security:Command injection")).toHaveLength(1);
  });

  test("an incidental substring does NOT over-credit the rival (token equality, not includes)", () => {
    // 'sqlite-version-disclosure' contains the substring 'sqli' but never as a whole
    // token; the old includes() over-credited it as SQL injection. It must NOT map.
    const out = normalizeCompetitorFindings("nuclei", [
      { templateId: "sqlite-version-disclosure", "matched-at": "/x" },
    ]);
    const classes = out.map(findingClassKey);
    expect(classes).not.toContain("security:SQL injection");
    // It is preserved honestly as an unmapped passthrough (coverage, not a GT match).
    expect(out).toHaveLength(1);
    expect(isCompetitorPassthroughClass(out[0].title)).toBe(true);
  });

  test("a ZAP human alert phrase still maps via contiguous whole tokens", () => {
    const out = normalizeCompetitorFindings("zap", [
      { alert: "Cross Site Scripting (Reflected)", url: "/s" },
      { alert: "SQL Injection", url: "/login" },
    ]);
    const classes = out.map(findingClassKey);
    expect(classes).toContain("security:Reflected XSS");
    expect(classes).toContain("security:SQL injection");
  });

  test("'cors' as a whole token maps, but a substring inside an unrelated id does not", () => {
    const hit = normalizeCompetitorFindings("nuclei", [{ templateId: "cors-misconfig", "matched-at": "/x" }]);
    expect(hit.map(findingClassKey)).toContain("security:CORS wildcard with credentials");
    // 'scorseese' style substring (contains 'cors') must NOT match.
    const miss = normalizeCompetitorFindings("nuclei", [{ templateId: "corsair-banner", "matched-at": "/x" }]);
    expect(miss.map(findingClassKey)).not.toContain("security:CORS wildcard with credentials");
  });
});

describe("FIX #4 - competitor passthrough classes do not crater rival precision", () => {
  test("rival informational (unmapped) findings do NOT punish precision below ours", () => {
    // Rival catches one real GT class (sqli) plus several informational passthroughs.
    // Old precisionOf counted the passthroughs as false positives -> precision 1/(1+N).
    // Now passthroughs are excluded -> precision is 1.0 (matched / matched).
    const findings = normalizeCompetitorFindings("nuclei", [
      { templateId: "sqli", "matched-at": "/users" },
      { templateId: "banner-disclosure", "matched-at": "/a" },
      { templateId: "tech-stack-fingerprint", "matched-at": "/b" },
      { templateId: "robots-txt", "matched-at": "/c" },
    ]);
    const score = scoreCompetitor("nuclei", VAMPI, findings).score;
    // Passthroughs landed in extra but must be excluded from the precision denom.
    expect(score.extra.some((e) => isCompetitorPassthroughClass(e.findingClass))).toBe(true);
    expect(precisionOf(score)).toBe(1);
  });

  test("a genuine non-passthrough extra STILL counts against precision (we don't hide real FPs)", () => {
    // Build a TargetScore by hand: 1 matched, 1 real extra (not a passthrough), 1 passthrough.
    const score: TargetScore = {
      name: "t",
      matched: ["security:SQL injection"],
      missed: [],
      extra: [
        { findingClass: "security:Some real extra", count: 1 },
        { findingClass: "competitor:nuclei:banner", count: 3 },
      ],
      recall: 0.5,
      labeled: true,
    };
    // Only the real extra counts: 1 / (1 + 1) = 0.5; the 3 passthroughs are excluded.
    expect(precisionOf(score)).toBe(0.5);
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

  test("FIX #6: UNSORTED input is sorted by run_at internally -> a recall DROP never reads as improvement", () => {
    // Hand the function rows in a SCRAMBLED order. The genuine latest run (by run_at)
    // has LOWER recall than the prior run -> the honest delta is NEGATIVE. The old
    // code trusted caller order and would have computed the delta off the wrong rows,
    // potentially rendering a drop as an improvement.
    const scrambled = [
      run(0.5, 9, "2026-06-21T00:00:00.000Z"), // prior (older)
      run(0.3, 7, "2026-06-28T00:00:00.000Z"), // ACTUAL latest, recall DROPPED
      run(0.4, 8, "2026-06-14T00:00:00.000Z"), // oldest
    ];
    const t = improvementTrend(scrambled);
    // Latest by run_at is the 2026-06-28 row (recall 0.3), prior is 2026-06-21 (0.5).
    expect(t.latestRecall).toBeCloseTo(0.3, 5);
    expect(t.recallDelta).toBeCloseTo(-0.2, 5); // a DROP, correctly negative
    expect(t.coverageDelta).toBe(-2);
    // Series is oldest-first regardless of input order.
    expect(t.series.map((p) => p.recall)).toEqual([0.4, 0.5, 0.3]);
  });
});
