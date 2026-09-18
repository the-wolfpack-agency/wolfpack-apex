/**
 * POST /api/admin/agent-probe/run - run a model (via the router) against an
 * allowlisted target and return how it behaved: a classified behavior report +
 * an operator dossier. This is the "test and prove it out" surface - point a
 * model at ogiam.com and watch it welcome, probe, or trip a trap.
 *
 * Locked down: capability-gated (settings.manage_team); the target must be on
 * the allowlist (400 otherwise); the harness confines every fetch to that
 * origin; page bodies are size-capped and each fetch is time-bounded, so a
 * hostile target cannot hang or flood the runner.
 *
 * Responses: 200 { report, dossier } | 400 invalid/target | 401/403 (auth).
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAIClient } from "@/lib/ai/router";
import { runProbeAgainstTarget, ProbeTargetNotAllowedError } from "@/lib/agent-probe-runner";
import type { AIModelTier } from "@/lib/ai/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIERS: readonly AIModelTier[] = ["cheap", "standard", "premium"];
const MAX_BODY_BYTES = 200_000; // cap a page body so a hostile target cannot flood us
const FETCH_TIMEOUT_MS = 8_000;

/** Bounded live fetch: time-limited and size-capped, returns a typed shape and
 *  never throws (a failed fetch is a 0-status empty page to the harness). */
async function boundedFetch(url: string): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "manual" });
    const text = await res.text();
    return { status: res.status, body: text.length > MAX_BODY_BYTES ? text.slice(0, MAX_BODY_BYTES) : text };
  } catch {
    return { status: 0, body: "" };
  } finally {
    clearTimeout(timer);
  }
}

interface Body {
  tier?: unknown;
  goal?: unknown;
  targetBase?: unknown;
  maxSteps?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_input", detail: "body must be JSON" }, { status: 400 });
  }

  const tier = TIERS.includes(body.tier as AIModelTier) ? (body.tier as AIModelTier) : "cheap";
  const goal = typeof body.goal === "string" && body.goal.trim() ? body.goal.trim().slice(0, 300) : "explore the site";
  const targetBase = typeof body.targetBase === "string" ? body.targetBase.trim() : "https://ogiam.com";
  const maxSteps = typeof body.maxSteps === "number" && Number.isFinite(body.maxSteps) ? Math.min(Math.max(1, Math.trunc(body.maxSteps)), 30) : 15;

  try {
    const result = await runProbeAgainstTarget({
      client: getAIClient(),
      tier,
      agentLabel: `${tier}-tier model`,
      goal,
      targetBase,
      fetchImpl: boundedFetch,
      runId: randomUUID(),
      at: new Date().toISOString(),
      workspaceId: auth.user.workspaceId ?? "default",
      maxSteps,
    });
    return NextResponse.json({ report: result.report, dossier: result.dossier, targetHost: result.targetHost });
  } catch (err) {
    if (err instanceof ProbeTargetNotAllowedError) {
      return NextResponse.json({ error: "target_not_allowed", detail: "that target is not on the probe allowlist" }, { status: 400 });
    }
    return NextResponse.json({ error: "probe_failed" }, { status: 500 });
  }
}
