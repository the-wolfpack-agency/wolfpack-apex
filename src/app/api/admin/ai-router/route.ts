/**
 * What the model router is doing, and which models it could use.
 *
 * Read-only. Everything is derived from decisions the router already logs, so
 * this adds no telemetry and costs nothing to switch on.
 *
 * DELIBERATELY NOT A CONFIGURATION ENDPOINT
 *
 * Availability is read from the environment, never written to it. Letting a
 * request change which models are reachable would make an HTTP call able to
 * redirect every AI call in the platform to a different provider, which is a
 * change that belongs in a deployment with a review, not in a form post.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getRouterInsights } from "@/lib/ai/models/insights";
import { getDeterministicShare } from "@/lib/ai/models/deterministic-share";

export const runtime = "nodejs";

/* NEVER CACHED, at either end.
 *
 * Reported 2026-08-19: "this doesn't seem to update". The route reads recent
 * events, so a cached copy is not a stale nicety, it is a page that says the
 * router did nothing while it is busy. force-dynamic keeps the framework from
 * treating it as static, and the no-store header keeps the BROWSER from
 * serving its own copy back on the next visit, which is the half a server-side
 * setting cannot reach. */
export const dynamic = "force-dynamic";

/** Clamped so a caller cannot ask for an unbounded scan of the event table. */
const MAX_DAYS = 180;
const DEFAULT_DAYS = 30;

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const raw = Number(req.nextUrl.searchParams.get("days"));
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_DAYS) : DEFAULT_DAYS;

  /* The share sits alongside the spend deliberately. Spend describes the
     calls we made; the share describes the ones we did not, and that is
     the number this product is sold on. Fetched in parallel so adding it
     costs latency only where the two queries overlap. */
  const [insights, deterministic] = await Promise.all([
    getRouterInsights(days),
    getDeterministicShare(days),
  ]);

  return NextResponse.json({ ...insights, deterministic }, {
    status: 200,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
