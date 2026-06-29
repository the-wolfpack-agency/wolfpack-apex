/**
 * THE COMPETITIVE BENCHMARK endpoint - the head-to-head + improvement-over-time
 * surface that proves to clients we find the same (and more) issues than the
 * leading free scanners.
 *
 *   POST  scores a competitor (OWASP ZAP / Nuclei) against ONE corpus target,
 *         head to head with us:
 *           body { tool, target, findings[] }  (or an array of those objects)
 *         For each entry it normalizes the raw findings into OUR taxonomy,
 *         scores them with the SAME scorer over the target's GROUND TRUTH, reads
 *         OUR latest score for that target (from listRecentBenchmarkRuns - the
 *         same source the base benchmark trend uses), builds the CompetitiveReport
 *         (per-tool recall/precision, rival-only gaps, parity), fires
 *         platform.competitor_benchmark_run (+ gap/parity events from the builder),
 *         persists via recordCompetitorRun, and audits. Returns the report(s).
 *
 *   GET   returns { comparison: latest per-tool-vs-us, improvement: our recall
 *         trend over time } for the dashboard's "Versus the competition" section.
 *
 * Dual auth mirrors the base benchmark route exactly: CI bearer CRON_SECRET OR the
 * settings.manage_team capability. Graceful-degrade idiom mirrored too: persistence
 * is best effort so a transient DB hiccup never loses a scored result.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { getBenchmarkTarget } from "@/lib/platform-scan/benchmark/corpus";
import { listRecentBenchmarkRuns } from "@/lib/platform-scan/benchmark/benchmark-store";
import {
  normalizeCompetitorFindings,
  scoreCompetitor,
  buildCompetitiveReport,
  improvementTrend,
  precisionOf,
  COMPETITOR_LABEL,
  type CompetitorTool,
  type RawCompetitorFinding,
  type CompetitiveReport,
} from "@/lib/platform-scan/benchmark/competitive";
import {
  recordCompetitorRun,
  listLatestCompetitorRunPerPair,
  ourLatestScoreForTarget,
} from "@/lib/platform-scan/benchmark/competitive-store";

/** CI path: Authorization: Bearer ${CRON_SECRET}. False when CRON_SECRET unset. */
function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

const VALID_TOOLS: CompetitorTool[] = ["zap", "nuclei"];

/** One competitor scoring request: a tool, a corpus target name, and the tool's
 *  raw findings JSON (loose; normalizeCompetitorFindings shapes them). */
interface CompetitiveRequest {
  tool: CompetitorTool;
  target: string;
  findings: RawCompetitorFinding[];
}

/** Validate + coerce one request entry. Returns null on a malformed entry so the
 *  caller can 400 with a clear message rather than 500. */
function parseEntry(raw: unknown): CompetitiveRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const tool = r.tool;
  const target = r.target;
  const findings = r.findings;
  if (typeof tool !== "string" || !VALID_TOOLS.includes(tool as CompetitorTool)) return null;
  if (typeof target !== "string" || !target.trim()) return null;
  if (!Array.isArray(findings)) return null;
  return {
    tool: tool as CompetitorTool,
    target: target.trim(),
    findings: findings as RawCompetitorFinding[],
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Resolve actor identity from whichever auth path succeeds (mirrors base route).
  let actorId = "benchmark-scorer";
  let actorRole = "agent";

  if (isAuthorizedCron(req)) {
    // CI path: anonymous agent scoring competitors against the corpus.
  } else {
    const auth = await requireCapability(req, "settings.manage_team");
    if (!auth.ok) return auth.response;
    actorId = auth.user.id;
    actorRole = auth.user.role;
  }

  // Parse the body: a single { tool, target, findings } OR an array of those.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const rawEntries = Array.isArray(body) ? body : [body];
  const entries: CompetitiveRequest[] = [];
  for (const raw of rawEntries) {
    const parsed = parseEntry(raw);
    if (!parsed) {
      return NextResponse.json(
        { ok: false, error: "each entry needs { tool: 'zap'|'nuclei', target, findings[] }" },
        { status: 400 },
      );
    }
    entries.push(parsed);
  }
  if (entries.length === 0) {
    return NextResponse.json({ ok: false, error: "no entries to score" }, { status: 400 });
  }

  // Every target must be in the consent corpus; an unknown target is refused (the
  // open internet is never a benchmark target - same contract as the base route).
  for (const e of entries) {
    if (!getBenchmarkTarget(e.target)) {
      return NextResponse.json(
        { ok: false, error: `target "${e.target}" is not in the consent benchmark corpus` },
        { status: 400 },
      );
    }
  }

  const deps = {
    trackEvent,
    actor: { id: actorId, role: actorRole },
  };

  const reports: CompetitiveReport[] = [];
  const runIds: (string | null)[] = [];

  for (const entry of entries) {
    const target = getBenchmarkTarget(entry.target)!;
    const normalized = normalizeCompetitorFindings(entry.tool, entry.findings);
    const competitorScore = scoreCompetitor(entry.tool, target, normalized);

    // Fire the head-to-head run event (the builder fires the gap/parity events).
    // A not-applicable metric (unlabeled target) is emitted as the explicit string
    // "n/a", never coerced to 0/1 which would read as a real score downstream.
    deps.trackEvent("platform.competitor_benchmark_run", actorId, actorRole, {
      tool: entry.tool,
      target: target.name,
      recall: competitorScore.score.recall ?? "n/a",
      precision: precisionOf(competitorScore.score) ?? "n/a",
      findings: competitorScore.findings,
    });

    // Fix #5: query OUR latest score for THIS target directly (not a truncated
    // window walk), so a newer run outside a 50-row window is never missed and we
    // never fabricate recall 0 for an unscored target (hasRun:false -> recall null).
    const ours = await ourLatestScoreForTarget(target.name);
    const report = buildCompetitiveReport(ours, [competitorScore], deps);
    reports.push(report);

    // Persist (best effort; analytics already emitted).
    const { id } = await recordCompetitorRun({
      tool: entry.tool,
      target: target.name,
      recall: competitorScore.score.recall,
      precision: precisionOf(competitorScore.score),
      findings: competitorScore.findings,
      report,
    });
    runIds.push(id);
  }

  // Audit the competitive scoring run (hash-chained, immutable): scoring a rival
  // against the corpus is a security-relevant agent action. Best effort.
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: actorId, role: actorRole },
    action: "platform.competitor_benchmark_scored",
    resourceType: "platform_competitor_benchmark_run",
    resourceId: runIds.find((id) => id) ?? "unknown",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
    afterState: {
      entries: entries.length,
      tools: [...new Set(entries.map((e) => COMPETITOR_LABEL[e.tool]))],
      targets: [...new Set(entries.map((e) => e.target))],
      rival_only_gaps: reports.reduce((n, r) => n + r.rivalOnlyGaps.length, 0),
      parity_targets: reports.filter((r) => r.parity).length,
    },
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({ ok: true, runIds, reports });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  // Comparison: the latest competitor run PER (tool, target), each laid next to
  // our recall on that target. Fix #7: select latest-per-pair in SQL (DISTINCT ON)
  // rather than de-duping a truncated 200-row window client-side, which could DROP
  // the newest run for a pair when older runs filled the window first.
  const competitorRuns = await listLatestCompetitorRunPerPair();
  const comparison = competitorRuns.map((r) => ({
    tool: r.tool,
    label: COMPETITOR_LABEL[r.tool] ?? r.tool,
    target: r.target,
    runAt: r.runAt,
    theirs: { recall: r.recall, precision: r.precision, findings: r.findings },
    // null (n/a) when not applicable - never a fabricated 0/1 that reads as a real
    // metric. The dashboard renders null as "n/a".
    ours: r.report?.ours ?? { recall: null, precision: null, matched: [] },
    rivalOnlyGaps: r.report?.rivalOnlyGaps ?? [],
    parity: r.report?.parity ?? null,
  }));

  // Improvement: OUR recall trend over time (the same source as the base trend).
  const ourRecent = await listRecentBenchmarkRuns(50);
  const improvement = improvementTrend(ourRecent);

  return NextResponse.json({ ok: true, comparison, improvement });
}
