/**
 * Continuous Engagement Orchestrator: the autonomy layer that makes a deployed
 * OGIAM run the engagement on its own. For an opted-in platform it re-scans
 * (static), re-profiles, and re-recommends, then leaves the findings / profile /
 * recommendations refreshed for the report. It is COMPOSITION of existing,
 * already-tested pieces, so there is one source of truth per step:
 *   recordScan      -> dedup + auto-resolve + critical alerting + Brain/learning
 *   buildSystemProfile/saveSystemProfile/ingest -> the knowledge model
 *   recommendAutomations/saveRecommendations/ingest -> the gated proposals
 *
 * Read-only against the target (static repo fetch + the persisted findings); it
 * proposes, never executes, so running it continuously carries no active risk.
 * "Opted in" = a platform that has already been profiled once (listSystemProfiles
 * is the registry), so the sweep never assesses a platform an operator did not
 * choose.
 */
import { resolveScanTarget } from "../manifests";
import { discoverRepoFiles } from "../static/discover-files";
import { scanSource, defaultReadFile } from "../static/scan";
import { recordScan, summarizeFindings, listFindings, listScans } from "../store";
import { buildSystemProfile } from "../profile/build";
import { saveSystemProfile, listSystemProfiles } from "../profile/store";
import { ingestSystemProfile } from "../profile/brain-ingest";
import { recommendAutomations } from "../recommend/engine";
import { saveRecommendations } from "../recommend/store";
import { ingestRecommendation } from "../recommend/brain-ingest";
import { trackEvent } from "@/lib/analytics";

export interface EngagementRunResult {
  platform: string;
  /** Set when the run did not assess (e.g. no static target, or an error). */
  skipped?: string;
  findingCount: number;
  criticalCount: number;
  autoResolvedCount: number;
  profiled: boolean;
  recommendationCount: number;
}

const EMPTY = (platform: string, skipped: string): EngagementRunResult => ({
  platform, skipped, findingCount: 0, criticalCount: 0, autoResolvedCount: 0, profiled: false, recommendationCount: 0,
});

/** Run the full engagement once for one platform: scan -> profile -> recommend. */
export async function runEngagement(workspaceId: string, platform: string): Promise<EngagementRunResult> {
  const manifest = await resolveScanTarget(workspaceId, platform);
  if (!manifest?.static) return EMPTY(platform, "no_static_target");

  const { owner, repo, ref, paths: seed } = manifest.static;
  const readFile = defaultReadFile(owner, repo, ref);

  // 1) Static scan. Discover the repo tree once and reuse it for the profile.
  const discovered = await discoverRepoFiles(owner, repo, ref).catch(() => [] as string[]);
  const paths = discovered.length > 0 ? Array.from(new Set([...seed, ...discovered])) : seed;
  const result = await scanSource({ platform, owner, repo, ref, paths, readFile });
  const scan = await recordScan({ workspaceId, actorId: "engagement", actorRole: "system", result });

  // 2) Profile (reuse the already-discovered paths; no second GitHub tree fetch).
  const profile = await buildSystemProfile(
    { platform, routes: manifest.routes },
    { discoverFiles: () => Promise.resolve(paths), readFile, summarize: () => summarizeFindings(workspaceId, platform) },
  );
  await saveSystemProfile(workspaceId, profile);
  await ingestSystemProfile(profile);

  // 3) Recommend from the fresh profile + findings.
  const scans = await listScans(workspaceId, 100);
  const findings = await listFindings(workspaceId, { status: "open", platform, limit: 500 });
  const recs = recommendAutomations({
    platform,
    profile,
    findings,
    scanCount: scans.filter((s) => s.platform === platform).length,
  });
  await saveRecommendations(workspaceId, platform, recs);
  await Promise.all(recs.map((r) => ingestRecommendation(platform, r)));

  trackEvent("platform.engagement_run", "engagement", "system", {
    platform,
    findings: scan.findingCount,
    criticals: scan.criticalCount,
    auto_resolved: scan.autoResolvedCount,
    recommendations: recs.length,
  });

  return {
    platform,
    findingCount: scan.findingCount,
    criticalCount: scan.criticalCount,
    autoResolvedCount: scan.autoResolvedCount,
    profiled: true,
    recommendationCount: recs.length,
  };
}

/** Sweep every opted-in platform (one that has been profiled). One platform's
 *  failure never aborts the sweep. */
export async function runDueEngagements(workspaceId = "default"): Promise<EngagementRunResult[]> {
  const profiles = await listSystemProfiles(workspaceId);
  const out: EngagementRunResult[] = [];
  for (const p of profiles) {
    try {
      out.push(await runEngagement(workspaceId, p.platform));
    } catch (err) {
      out.push(EMPTY(p.platform, `error:${(err as Error)?.message ?? "unknown"}`));
    }
  }
  return out;
}
