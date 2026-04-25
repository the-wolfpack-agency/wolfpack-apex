/**
 * POST /api/meetings/feeds/[slug]/messages/[messageId]/analysis/regenerate
 *
 * Manually re-runs the analyzer for one message. Capability:
 * `meetings.manage`. Rate-limited (per-user + per-message debounce) to
 * stop accidental burst-clicking from melting the LLM bill.
 *
 * Auditing: this is a user-initiated mutation that triggers an LLM
 * call; we fire `automations.message_reanalyze_requested` analytics.
 * The route is allowlisted in AUDIT_ALLOWLIST because the actual
 * mutation (the upsert) lives in run-analyzer.ts and is audited via
 * `automations.message_analyzed`.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { getFeedBySlug } from "@/lib/automations/meeting-insights/feeds-repo";
import { getMessage } from "@/lib/automations/meeting-insights/messages-repo";
import { getLatestAnalysisForMessage } from "@/lib/automations/meeting-insights/analyses-repo";
import { runAnalyzer } from "@/lib/automations/meeting-insights/run-analyzer";

interface Ctx {
  params: Promise<{ slug: string; messageId: string }>;
}

/**
 * In-process rate limiter keyed on (user, message). 30s minimum gap.
 * For a hosted deployment this should move to Redis, but the per-process
 * cap is enough at our scale + protects against double-click bursts.
 */
const RATE_LIMIT_WINDOW_MS = 30_000;
const recentReanalyses = new Map<string, number>();

function rateLimitKey(userId: string, messageId: string): string {
  return `${userId}:${messageId}`;
}

function checkRateLimit(userId: string, messageId: string): boolean {
  const key = rateLimitKey(userId, messageId);
  const now = Date.now();
  const last = recentReanalyses.get(key);
  if (last && now - last < RATE_LIMIT_WINDOW_MS) return false;
  recentReanalyses.set(key, now);
  // Drop oldest entries if the map grows past 1000 keys.
  if (recentReanalyses.size > 1000) {
    const firstKey = recentReanalyses.keys().next().value;
    if (firstKey) recentReanalyses.delete(firstKey);
  }
  return true;
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireCapability(req, "meetings.manage");
  if (!auth.ok) return auth.response;
  const { slug, messageId } = await ctx.params;

  const feed = await getFeedBySlug(slug);
  if (!feed) {
    return NextResponse.json({ error: "feed_not_found" }, { status: 404 });
  }

  const message = await getMessage({ feed_id: feed.id, message_id: messageId });
  if (!message) {
    return NextResponse.json({ error: "message_not_found" }, { status: 404 });
  }

  if (!checkRateLimit(auth.user.id, message.id)) {
    return NextResponse.json(
      {
        error: "rate_limited",
        detail: "wait at least 30 seconds before re-running analysis",
      },
      { status: 429 },
    );
  }

  const prior = await getLatestAnalysisForMessage(message.id);

  trackEvent(
    "automations.message_reanalyze_requested",
    auth.user.id,
    auth.user.role,
    {
      automation_id: "meeting-insights",
      feed_id: feed.id,
      feed_slug: feed.slug,
      message_id: message.id,
      prior_status: prior?.status ?? "none",
    },
  );

  const outcome = await runAnalyzer({
    feed_id: feed.id,
    message_id: message.id,
  });

  if (!outcome.record) {
    return NextResponse.json(
      {
        ok: false,
        error: outcome.error ?? "analyzer_failed",
      },
      { status: 500 },
    );
  }

  // Mirror the analyzer event so dashboards can correlate manual triggers.
  trackEvent("automations.message_analyzed", auth.user.id, auth.user.role, {
    automation_id: "meeting-insights",
    feed_id: feed.id,
    feed_slug: feed.slug,
    message_id: message.id,
    analyzer_version: outcome.record.analyzer_version,
    status: outcome.record.status,
    topics: outcome.record.topics.length,
    decisions: outcome.record.decisions.length,
    action_items: outcome.record.action_items.length,
    tokens_used: outcome.record.tokens_used ?? 0,
    triggered_by: "manual",
  });

  return NextResponse.json({
    ok: true,
    analysis: outcome.record,
  });
}

/* ------------------------------------------------------------------ */
/* Test exports                                                        */
/* ------------------------------------------------------------------ */
export const __test__ = {
  recentReanalyses,
  RATE_LIMIT_WINDOW_MS,
};
