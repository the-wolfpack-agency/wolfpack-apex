/**
 * Cached, fail-open per-model VALUE SCORES for the live router (A1c step 2).
 *
 * The router's bridgeSelection can route on a learned value map (step 1); this is
 * the source. It reads recent pipeline runs -> grades -> modelValueScores (the ONE
 * producer - DRY, no second scorer) per workspace, CACHED with a TTL and refreshed
 * in the BACKGROUND, so resolveProvider (which runs on every AI call) reads
 * synchronously and NEVER blocks or throws. A cold cache or any failure returns {}
 * -> the router's prior cost/tier behavior. Value-routing can only REFINE the
 * choice among capable+available models, never make a call fail.
 *
 * Two guards keep this safe to turn on:
 *  - FLAG (AI_VALUE_ROUTING): dark by default; enable after observing in prod.
 *  - FEATURE SCOPE: the scores come from CODE-AUTHORING runs, so they only route
 *    factory/ai-code features. Every other AI caller (assistant, summaries, ...)
 *    keeps default routing - a code-authoring profile must not steer unrelated work.
 */
import { listPipelineRuns, toRunRecords } from "@/lib/ai-code/runs";
import { gradeRuns } from "@/lib/ai-code/grading";
import { modelValueScores } from "@/lib/ai-code/model-benchmark";

const TTL_MS = 10 * 60 * 1000;
const RUN_WINDOW = 200;
const cache = new Map<string, { scores: Record<string, number>; at: number }>();
const inflight = new Set<string>();

/** Dark by default. Enable with AI_VALUE_ROUTING=on|true|1 after observing. */
export function valueRoutingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(on|true|1)$/i.test((env.AI_VALUE_ROUTING ?? "").trim());
}

/** The scores are from code-authoring runs, so only factory features may use them. */
export function isFactoryFeature(feature: string | undefined): boolean {
  return /^(ai-code|dogfood|factory)/i.test((feature ?? "").trim());
}

async function refresh(wsId: string): Promise<void> {
  if (inflight.has(wsId)) return;
  inflight.add(wsId);
  try {
    const runs = await listPipelineRuns(wsId, RUN_WINDOW);
    const scores = modelValueScores(gradeRuns(toRunRecords(runs)).byModel);
    cache.set(wsId, { scores, at: Date.now() });
  } catch {
    /* fail-open: keep the prior cache (or none); never poison routing */
  } finally {
    inflight.delete(wsId);
  }
}

/**
 * Sync read of the cached value map for a workspace. Triggers a BACKGROUND refresh
 * on a cold/stale entry (stale-while-revalidate) and returns the current cached map
 * immediately - {} until the first refresh lands. Never blocks, never throws.
 */
export function cachedModelValueScores(workspaceId: string, now: number = Date.now()): Record<string, number> {
  const wsId = workspaceId || "default";
  const hit = cache.get(wsId);
  if (!hit || now - hit.at > TTL_MS) void refresh(wsId);
  return hit?.scores ?? {};
}

// --- test seams (no production caller) ---
export function _resetValueScoreCache(): void { cache.clear(); inflight.clear(); }
export function _primeValueScoreCache(workspaceId: string, scores: Record<string, number>, at: number = Date.now()): void {
  cache.set(workspaceId || "default", { scores, at });
}
