/**
 * Server-side wiring: the real comparator, and the drain that turns one queued
 * acceptance run into a stored verdict.
 *
 * Kept separate from run.ts on purpose. run.ts is the logic and is testable with
 * no browser and no database; this file is the part that owns the heavy, real
 * dependencies (Playwright, Postgres, the SSRF guard) and therefore the part
 * that must never be needed to prove the rules are right.
 */
import { trackEvent } from "@/lib/analytics";
import { assertScannableUrl } from "@/lib/platform-scan/ssrf-guard";
import { runSpecDiff } from "@/lib/spec-diff/run";
import { createSpecDiffBrowser } from "@/lib/spec-diff/browser";
import { saveSpecDiffRun } from "@/lib/spec-diff/store";
import { runAcceptance, statusFromVerdict, type AcceptanceRunDeps, type LayoutComparison } from "./run";
import { parseCriteria, type AcceptanceCriteria } from "./criteria";
import {
  claimNextAcceptanceRun,
  completeAcceptanceRun,
  getAcceptanceCriteria,
  type StoredAcceptanceRun,
} from "./store";

/**
 * The real layout comparison: drive the existing spec-diff engine at both URLs
 * and persist the measurements, so an acceptance verdict links to the numbers
 * behind it rather than asserting them.
 *
 * Resolves with `{ error }` instead of rejecting. A browser that will not start
 * is a fact about this run, and the route results gathered alongside it are
 * still worth keeping.
 */
export function makeLayoutComparator(workspaceId: string, createdBy: string | null) {
  return async function compareLayout(input: {
    prototypeUrl: string;
    deployedUrl: string;
    criteria: AcceptanceCriteria;
  }): Promise<LayoutComparison> {
    let browser: Awaited<ReturnType<typeof createSpecDiffBrowser>> | null = null;
    const startedAt = Date.now();
    try {
      browser = await createSpecDiffBrowser();
    } catch (err) {
      return { error: `browser unavailable: ${err instanceof Error ? err.message : "unknown"}` };
    }
    try {
      const run = await runSpecDiff(
        {
          specUrl: input.prototypeUrl,
          targetUrl: input.deployedUrl,
          viewports: input.criteria.viewports,
          tolerancePx: input.criteria.tolerancePx,
          ...browser.hooks,
        },
        browser.browser,
      );
      let specDiffRunId: string | null = null;
      try {
        specDiffRunId = await saveSpecDiffRun(workspaceId, run, {
          viewports: input.criteria.viewports,
          durationMs: Date.now() - startedAt,
          createdBy,
        });
      } catch {
        // The measurements are what matter to the verdict; failing to file them
        // must not turn a completed comparison into an unmeasured one.
        specDiffRunId = null;
      }
      return { summary: run.summary, specDiffRunId };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "comparison failed" };
    } finally {
      await browser?.close().catch(() => {});
    }
  };
}

/** Production dependency set: real fetch, real browser, real SSRF guard. */
export function acceptanceDeps(workspaceId: string, createdBy: string | null): AcceptanceRunDeps {
  return {
    compareLayout: makeLayoutComparator(workspaceId, createdBy),
    assertPublicUrl: async (url: string) => {
      await assertScannableUrl(url);
    },
  };
}

export interface DrainResult {
  claimed: number;
  passed: number;
  failed: number;
  degraded: number;
  runIds: string[];
}

/**
 * Execute one claimed run to completion and write its terminal state.
 *
 * A run whose project has no stored criteria still runs, against the defaults.
 * Skipping it would mean a build nobody wrote criteria for is also a build
 * nobody ever checked, which is the status quo this layer replaces.
 */
export async function executeAcceptanceRun(
  run: StoredAcceptanceRun & { workspace_id?: string },
  depsFor: (workspaceId: string, createdBy: string | null) => AcceptanceRunDeps = acceptanceDeps,
): Promise<"passed" | "failed" | "degraded"> {
  const workspaceId = (run.workspace_id as string) ?? "default";
  const stored = await getAcceptanceCriteria(workspaceId, run.project_id);
  const criteria = stored?.criteria ?? parseCriteria(null);

  if (!run.deployed_url) {
    // No URL means there is nothing to look at. That is a degraded run, not a
    // pass and not a silent skip.
    await completeAcceptanceRun(workspaceId, run.id, {
      status: "degraded",
      lastError: "the deploy reported no URL, so there was nothing to check",
      durationMs: 0,
    });
    trackEvent("site.acceptance_degraded", "system", "system", { project_id: run.project_id, reason: "no_deployed_url" });
    return "degraded";
  }

  try {
    const result = await runAcceptance(
      { deployedUrl: run.deployed_url, criteria },
      depsFor(workspaceId, run.project_id),
    );
    const status = statusFromVerdict(result.verdict);
    await completeAcceptanceRun(workspaceId, run.id, {
      status,
      verdict: result.verdict,
      specDiffRunId: result.specDiffRunId,
      durationMs: result.durationMs,
    });
    // Closed loop: the outcome, what failed, and how completely the intake was
    // specified all become data the brain can learn "which intakes build right
    // the first time" from.
    trackEvent(`site.acceptance_${status}`, "system", "system", {
      project_id: run.project_id,
      deploy_id: run.deploy_id,
      run_id: run.id,
      completeness: stored?.completeness ?? 0,
      failed_checks: result.verdict.checks.filter((c) => c.status === "failed").map((c) => c.id).join(",") || "none",
      unmeasured_checks: result.verdict.checks.filter((c) => c.status === "unmeasured").map((c) => c.id).join(",") || "none",
      duration_ms: result.durationMs,
    });
    return status;
  } catch (err) {
    const message = err instanceof Error ? err.message : "acceptance run failed";
    await completeAcceptanceRun(workspaceId, run.id, { status: "degraded", lastError: message });
    trackEvent("site.acceptance_degraded", "system", "system", { project_id: run.project_id, reason: "runner_threw" });
    return "degraded";
  }
}

/**
 * Drain up to `max` queued runs. Sequential on purpose: each run may start a
 * browser, and several at once on one serverless instance is how a sweep runs
 * out of memory and reports nothing at all.
 */
export async function drainAcceptanceQueue(
  max = 3,
  depsFor: (workspaceId: string, createdBy: string | null) => AcceptanceRunDeps = acceptanceDeps,
): Promise<DrainResult> {
  const out: DrainResult = { claimed: 0, passed: 0, failed: 0, degraded: 0, runIds: [] };
  for (let i = 0; i < max; i++) {
    const run = await claimNextAcceptanceRun();
    if (!run) break;
    out.claimed++;
    out.runIds.push(run.id);
    const status = await executeAcceptanceRun(run, depsFor);
    out[status]++;
  }
  return out;
}
