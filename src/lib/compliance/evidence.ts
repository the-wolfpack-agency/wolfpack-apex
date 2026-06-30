/**
 * Evidence collector: gather the live, measured signals the compliance engine
 * derives status from. This is the "all data consumed to benefit the system"
 * seam - it reads the existing stores (audit ledger, gate decisions, red-team,
 * AI inventory, enforce posture) and turns them into one EvidenceInputs.
 *
 * Every source is best-effort: a missing store or DB error degrades that signal
 * to its safe default (which the crosswalk reads as a gap/partial), so a cold
 * system reports honest gaps rather than throwing. Never invents evidence.
 */
import { verifyChain } from "@/lib/audit-log";
import { summarizeDecisions } from "@/lib/ogiam/queries";
import { listEnforcementPolicy } from "@/lib/ogiam/enforcement-policy";
import { listRuns } from "@/lib/ai-redteam/store";
import { summarizeSurfaces } from "@/lib/ai-surface/store";
import type { EvidenceInputs } from "./types";

const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export async function collectEvidence(workspaceId: string, nowMs = Date.now()): Promise<EvidenceInputs> {
  const [chain, decisions, posture, runs, surfaces] = await Promise.all([
    safe(() => verifyChain(), { valid: false, checkedCount: 0 } as { valid: boolean; checkedCount: number }),
    safe(() => summarizeDecisions(workspaceId), { total: 0, would_block: 0, by_tier: {}, by_outcome: {} }),
    safe(() => listEnforcementPolicy(workspaceId), [] as Array<{ mode: string }>),
    safe(() => listRuns(workspaceId, 1), [] as Array<{ passRate: number; createdAt: string }>),
    safe(() => summarizeSurfaces(workspaceId), { total: 0, ungoverned: 0, byKind: {}, byProvider: {}, byRisk: {} }),
  ]);

  const latest = runs[0];
  const redteamRecent = !!latest && nowMs - new Date(latest.createdAt).getTime() < RECENT_MS;

  return {
    auditChainValid: chain.valid && chain.checkedCount > 0,
    auditEntries: chain.checkedCount,
    gateDecisions: decisions.total,
    gateWouldBlock: decisions.would_block,
    enforceCapabilities: posture.filter((p) => p.mode === "enforce").length,
    redteamPassRate: latest ? latest.passRate : null,
    redteamRecent,
    aiSurfacesTotal: surfaces.total,
    ungovernedAiSurfaces: surfaces.ungoverned,
  };
}
