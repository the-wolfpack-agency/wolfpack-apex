/**
 * Live agent-probe runner - run a real model (via the platform router) against
 * an allowlisted target and produce a classified report + an operator dossier.
 *
 * This is the operational capstone: it composes the pieces (router -> driver ->
 * harness -> report -> dossier) into one call, so "run gpt/claude/etc. against
 * ogiam.com and see how it behaves" is a single function. Injected client +
 * fetch keep it unit-testable with no network and no keys; the admin route wires
 * the real router and a bounded fetch.
 *
 * SAFETY. Two SSRF layers: the target BASE must be on an allowlist (so a caller
 * cannot point the runner at an internal host), and the harness itself confines
 * every fetch to that base's origin. The model only ever picks paths; it can
 * never redirect the runner off the allowlisted site.
 */

import { runAgentProbe, reportProbeRun, type ProbeReport } from "@/lib/agent-probe";
import { makeModelDriver, type CompleteFn } from "@/lib/agent-probe-driver";
import { analyzeToolComposition } from "@/lib/agent-tool-composition";
import { buildDossier, type AttributionDossier, type Sighting } from "@/lib/agent-dossier";
import type { AIClient, AIModelTier } from "@/lib/ai/types";

/** Targets the runner may probe. Only ogiam.com by default; override with a
 *  comma-separated OGIAM_PROBE_TARGETS. Never wildcard, never internal. */
export const DEFAULT_PROBE_TARGETS = ["https://ogiam.com"] as const;

export function allowedProbeTargets(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.OGIAM_PROBE_TARGETS;
  if (raw && raw.trim()) return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return [...DEFAULT_PROBE_TARGETS];
}

export function isAllowedTarget(base: string, env: NodeJS.ProcessEnv = process.env): boolean {
  let b: URL;
  try {
    b = new URL(base);
  } catch {
    return false;
  }
  if (b.protocol !== "https:" && b.protocol !== "http:") return false;
  return allowedProbeTargets(env).some((t) => {
    try {
      return new URL(t).origin === b.origin;
    } catch {
      return false;
    }
  });
}

/** Adapt the router's AIClient.complete to the driver's simple text CompleteFn. */
export function routerCompleteFn(
  client: Pick<AIClient, "complete">,
  tier: AIModelTier,
  workspaceId?: string,
): CompleteFn {
  return async (prompt: string) => {
    const res = await client.complete({
      messages: [{ role: "user", content: prompt }],
      model_tier: tier,
      // The model only replies with a single path (or STOP), so a tiny cap.
      max_tokens: 64,
      metadata: { feature: "agent_probe", workspace_id: workspaceId },
    });
    return res.content ?? "";
  };
}

export interface RunProbeOptions {
  client: Pick<AIClient, "complete">;
  tier: AIModelTier;
  /** Human label for the agent under test, e.g. "standard-tier model". */
  agentLabel: string;
  goal: string;
  targetBase: string;
  /** Injected so tests need no network; the route provides a bounded live fetch. */
  fetchImpl: (url: string) => Promise<{ status: number; body: string }>;
  runId: string;
  /** Injected timestamp (avoids Date.now in the pure path; the route stamps it). */
  at: string;
  workspaceId?: string;
  maxSteps?: number;
}

export interface ProbeRunResult {
  report: ProbeReport;
  sighting: Sighting;
  dossier: AttributionDossier;
  targetHost: string;
}

export class ProbeTargetNotAllowedError extends Error {
  constructor(base: string) {
    super(`probe target not allowed: ${base}`);
    this.name = "ProbeTargetNotAllowedError";
  }
}

/**
 * Run one model against one allowlisted target. Throws
 * ProbeTargetNotAllowedError if the base is not on the allowlist (checked before
 * any fetch or model call).
 */
export async function runProbeAgainstTarget(opts: RunProbeOptions): Promise<ProbeRunResult> {
  if (!isAllowedTarget(opts.targetBase)) throw new ProbeTargetNotAllowedError(opts.targetBase);

  const complete = routerCompleteFn(opts.client, opts.tier, opts.workspaceId);
  const run = await runAgentProbe({
    runId: opts.runId,
    agentLabel: opts.agentLabel,
    goal: opts.goal,
    base: opts.targetBase,
    driver: makeModelDriver({ complete, base: opts.targetBase, goal: opts.goal }),
    fetchImpl: opts.fetchImpl,
    clock: () => opts.at,
    maxSteps: opts.maxSteps,
  });

  const report = reportProbeRun(run);
  const targetHost = new URL(opts.targetBase).host;
  // This harness gives the agent only a fetch tool, so the tool-composition is
  // benign by construction; the dossier's threat here comes from BEHAVIOR. The
  // tool signal turns on when the harness offers a tool menu (the next layer).
  const tools = analyzeToolComposition(["fetch"]);
  const sighting: Sighting = {
    surface: targetHost,
    at: opts.at,
    journey: report.journey,
    scaffolding: report.scaffolding,
    tools,
  };
  const dossier = buildDossier([sighting]);

  return { report, sighting, dossier, targetHost };
}
