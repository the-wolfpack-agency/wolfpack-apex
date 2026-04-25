/**
 * GET /api/meetings/feeds/[slug]/messages/[messageId]/analysis
 *
 * Returns the latest analysis snapshot for one message. Capability:
 * `meetings.view`. The UI polls this endpoint; if the analyzer hasn't
 * run yet (or no row exists) the response is `{ analysis: null }` and
 * the UI shows a loading state.
 *
 * Read-only — no audit; row creation is audited via
 * `automations.message_analyzed` from the analyzer pipeline.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { getFeedBySlug } from "@/lib/automations/meeting-insights/feeds-repo";
import { getMessage } from "@/lib/automations/meeting-insights/messages-repo";
import { getLatestAnalysisForMessage } from "@/lib/automations/meeting-insights/analyses-repo";
import { ANALYZER_VERSION } from "@/lib/automations/meeting-insights/analyzer/types";
import { isAnalyzerAvailable } from "@/lib/automations/meeting-insights/analyzer/anthropic";

interface Ctx {
  params: Promise<{ slug: string; messageId: string }>;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireCapability(req, "meetings.view");
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

  const analysis = await getLatestAnalysisForMessage(message.id);

  trackEvent("system.page_viewed", auth.user.id, auth.user.role, {
    page: "meeting_message_analysis",
    feed_id: feed.id,
    message_id: message.id,
    has_analysis: analysis ? "true" : "false",
  });

  return NextResponse.json({
    analysis,
    analyzer_version: ANALYZER_VERSION,
    analyzer_available: isAnalyzerAvailable(),
  });
}
