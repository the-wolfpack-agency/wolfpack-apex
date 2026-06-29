/**
 * Server-side BENCHMARK SCORING endpoint — the active-learning loop, native.
 *
 * The CI sweep ingests scan findings into the shared store (see
 * ingest/route.ts). This route closes the loop: it scores those ALREADY-INGESTED
 * findings against the consent-to-test corpus's per-target GROUND TRUTH, mines
 * "improve the tool" learning signals, persists the run, and trends it — so
 * "run on the corpus -> score vs ground truth -> mine gaps" is automatic and
 * trended, with no data lost.
 *
 *   POST  triggers a scoring run: for each corpus target, reads its OPEN findings
 *         from the store, builds a BenchmarkResult, calls scoreBenchmark (fires
 *         platform.benchmark_run) + extractLearningSignals (fires the per-signal
 *         events), persists via recordBenchmarkRun, audits, and returns the
 *         report + signals. A target whose findings read throws is counted as
 *         errored and the run still completes.
 *
 *   GET   returns the recent runs for the dashboard (recall/coverage trend + the
 *         latest signal backlog).
 *
 * Dual auth mirrors ingest/route.ts: CI bearer CRON_SECRET OR the
 * settings.manage_team capability. Graceful-degrade idiom mirrored too: a store
 * read that throws for one target does not fail the run, and persistence is best
 * effort so a transient DB hiccup never loses the scored result.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { listFindings } from "@/lib/platform-scan/store";
import type { ScanFinding } from "@/lib/platform-scan/types";
import { BENCHMARK_CORPUS } from "@/lib/platform-scan/benchmark/corpus";
import {
  scoreBenchmark,
  extractLearningSignals,
  type BenchmarkResult,
} from "@/lib/platform-scan/benchmark/scorer";
import {
  recordBenchmarkRun,
  listRecentBenchmarkRuns,
} from "@/lib/platform-scan/benchmark/benchmark-store";
import { trackEvent } from "@/lib/analytics";

/** CI path: Authorization: Bearer ${CRON_SECRET}. False when CRON_SECRET unset. */
function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

/** The scorer only reads category + title off a finding (findingClassKey), but
 *  its input type is ScanFinding. Map a stored ScanFindingRow down to that shape
 *  so the score path is exercised end-to-end on real ingested data. */
function toScanFinding(r: {
  route: string;
  severity: ScanFinding["severity"];
  category: ScanFinding["category"];
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
}): ScanFinding {
  return {
    route: r.route,
    severity: r.severity,
    category: r.category,
    title: r.title,
    detail: r.detail,
    evidence: r.evidence as ScanFinding["evidence"],
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Resolve actor identity from whichever auth path succeeds (mirrors ingest).
  let workspaceId = "default";
  let actorId = "benchmark-scorer";
  let actorRole = "agent";

  if (isAuthorizedCron(req)) {
    // CI path: anonymous agent scoring the default workspace's ingested findings.
  } else {
    const auth = await requireCapability(req, "settings.manage_team");
    if (!auth.ok) return auth.response;
    workspaceId = auth.user.workspaceId ?? "default";
    actorId = auth.user.id;
    actorRole = auth.user.role;
  }

  // Build one BenchmarkResult per corpus target from its OPEN ingested findings.
  // A read that throws for a target marks it errored (robustness accounting) but
  // never fails the whole run — the loop must keep scoring the rest of the corpus.
  const results: BenchmarkResult[] = [];
  for (const target of BENCHMARK_CORPUS) {
    try {
      const rows = await listFindings(workspaceId, {
        platform: target.name,
        status: "open",
      });
      results.push({ target, findings: rows.map(toScanFinding), errored: false });
    } catch (err) {
      const detail = (err as Error).message;
      console.warn(
        `[platform-scans/benchmark] listFindings failed for ${target.name}:`,
        detail,
      );
      // DEGRADE SIGNAL: a swallowed read means recall/coverage will be computed
      // over a SMALLER corpus than intended. Without this event the learning loop
      // would treat a partial run as a real one and trend on numbers that silently
      // dropped a target. The errored count still flows into the report (below);
      // this fires the explicit signal so the partial run is never mistaken for a
      // clean one. The run still completes - we never fail the whole sweep for one
      // target's read.
      trackEvent("platform.scan_read_degraded", actorId, actorRole, {
        surface: "benchmark",
        detail,
        target: target.name,
        workspace_id: workspaceId,
      });
      results.push({ target, findings: [], errored: true });
    }
  }

  // Score (fires platform.benchmark_run) + mine signals (fires the per-signal
  // events). Default scorer deps attribute to the system actor so the events
  // reach the learning loop on unattended cron runs too.
  const report = scoreBenchmark(results);
  const signals = extractLearningSignals(report);

  // Persist the run (best effort; the scorer already emitted analytics).
  const { id } = await recordBenchmarkRun(report, signals);

  // Audit the scoring run (hash-chained, immutable): scoring the corpus is a
  // security-relevant agent action. Best effort.
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: actorId, role: actorRole },
    action: "platform.benchmark_scored",
    resourceType: "platform_benchmark_run",
    resourceId: id ?? "unknown",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
    afterState: {
      targets: report.targets,
      labeled_targets: report.labeledTargets,
      recall: report.recall,
      precision: report.precision,
      coverage_classes: report.coverageClasses.length,
      errored: report.erroredCount,
      signals: signals.length,
    },
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({ ok: true, runId: id, report, signals });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;

  const runs = await listRecentBenchmarkRuns(limit);
  return NextResponse.json({ ok: true, runs });
}
