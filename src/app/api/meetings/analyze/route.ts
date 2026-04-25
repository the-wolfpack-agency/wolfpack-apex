/**
 * POST /api/meetings/analyze
 *
 * Phase 5 — ad-hoc multi-term analysis. Body is an `AnalyzeRequest`;
 * response is an `AnalyzeResponse` (matched messages + aggregated
 * themes/actions/decisions + counts).
 *
 * Auth: meetings.manage (this surface composes filters, browses
 * historical email subjects, and offers "save as feed" — same
 * sensitivity as feed creation).
 *
 * No re-poll. We query already-ingested rows in
 * `instinct_meeting_messages`. Aggregation is deterministic counting
 * over Phase 2/3's stored analyses (NO new LLM calls).
 *
 * Audit: row + event are the trail. Analytics fires
 * `meeting_insights.analyze_run` with the actor + counts; the
 * concrete messages aren't mutated, just read. Allowlisted in
 * AUDIT_ALLOWLIST as a read-only POST.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { searchMessages } from "@/lib/automations/meeting-insights/messages-repo";
import { getAnalysesByMessageIds } from "@/lib/automations/meeting-insights/analyses-repo";
import {
  aggregateActions,
  aggregateDecisions,
  aggregateThemes,
} from "@/lib/automations/meeting-insights/aggregator";
import { validateAnalyzeRequest } from "@/lib/automations/meeting-insights/validation";
import {
  livePullInbox,
  type LivePullMatch,
} from "@/lib/automations/meeting-insights/live-pull";
import type {
  AnalyzeMatchedMessage,
  AnalyzeResponse,
  MeetingAnalysisRecord,
} from "@/lib/automations/meeting-insights/types";

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "meetings.manage");
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json" },
      { status: 400 },
    );
  }

  const validation = validateAnalyzeRequest(body);
  if (!validation.ok) {
    return NextResponse.json(
      { error: "invalid_input", detail: validation.error },
      { status: 400 },
    );
  }
  const filters = validation.value;

  const messages = await searchMessages({
    subject_match: filters.subject_match,
    sender_match: filters.sender_match,
    since: filters.since,
    until: filters.until,
    limit: 500,
  });

  const ids = messages.map((m) => m.id);
  const analysesById = await getAnalysesByMessageIds(ids);

  const presentAnalyses: MeetingAnalysisRecord[] = [];
  const messageMeta = new Map<string, { received_at: string; subject: string }>();
  for (const m of messages) {
    messageMeta.set(m.id, { received_at: m.received_at, subject: m.subject });
    const a = analysesById.get(m.id);
    if (a) presentAnalyses.push(a);
  }

  const aggregated_themes = aggregateThemes(presentAnalyses, messageMeta).slice(0, 10);
  const aggregated_action_items = aggregateActions(presentAnalyses);
  const aggregated_decisions = aggregateDecisions(presentAnalyses);

  const matched_messages: AnalyzeMatchedMessage[] = messages.map((m) => ({
    id: m.id,
    feed_id: m.feed_id,
    feed_slug: m.feed_slug,
    feed_name: m.feed_name,
    subject: m.subject,
    from_address: m.from_address,
    received_at: m.received_at,
    has_analysis: analysesById.has(m.id),
  }));

  const feedsTouched = new Set(messages.map((m) => m.feed_id)).size;

  /* Live-pull escape hatch: when ?live_pull=true (or body.live_pull),
     also do a one-shot Microsoft Graph scan against the logged-in
     user's inbox using the same typed filters. Returns matched email
     metadata + bodyPreview WITHOUT persisting or analyzing — lets the
     operator see what's there before deciding to ingest. */
  type ResponseWithLive = AnalyzeResponse & {
    live_pull?: {
      enabled: boolean;
      skipped: boolean;
      skipped_reason?: string;
      inbox_seen: number;
      truncated: boolean;
      matches: LivePullMatch[];
    };
  };

  const wantsLivePull =
    (body as { live_pull?: boolean } | null)?.live_pull === true;

  let livePullPart: ResponseWithLive["live_pull"] | undefined;
  if (wantsLivePull) {
    /* Try both auth.user.id AND auth.user.email — the MS token might
       be anchored on either depending on when/how it was connected.
       getValidToken's dual lookup matches connected_by OR user_email
       so handing it the id usually wins, but if the user's Instinct
       email IS the same as their MS mailbox we want that fallback too.
       livePullInbox tries the first key; if it returns no_user_connected,
       we retry with the other. */
    const tryLivePull = (key: string) =>
      livePullInbox({
        userId: key,
        filters: {
          subject_match: filters.subject_match,
          sender_match: filters.sender_match,
          since: filters.since,
          until: filters.until,
          limit: 50,
        },
      });

    try {
      /* Try the user's id first (matches connected_by on the token row
         when MS Graph was connected via the standard flow). */
      let live = await tryLivePull(auth.user.id);
      /* Fallback: if id lookup said no_user_connected and the user has
         an email, try that key — covers tokens anchored on email. */
      if (live.skipped && live.skipped_reason === "no_user_connected" && auth.user.email && auth.user.email !== auth.user.id) {
        live = await tryLivePull(auth.user.email);
      }
      livePullPart = {
        enabled: true,
        skipped: live.skipped,
        skipped_reason: live.skipped_reason,
        inbox_seen: live.inbox_seen,
        truncated: live.truncated,
        matches: live.matched,
      };
    } catch (err) {
      /* Never block the ingested-data results on a Graph hiccup. */
      livePullPart = {
        enabled: true,
        skipped: true,
        skipped_reason: (err as Error).message,
        inbox_seen: 0,
        truncated: false,
        matches: [],
      };
    }
  }

  const response: ResponseWithLive = {
    matched_messages,
    aggregated_themes,
    aggregated_action_items,
    aggregated_decisions,
    counts: {
      matched: messages.length,
      analyzed: presentAnalyses.length,
      feeds_touched: feedsTouched,
    },
    filters,
    ...(livePullPart ? { live_pull: livePullPart } : {}),
  };

  trackEvent("meeting_insights.analyze_run", auth.user.id, auth.user.role, {
    matched: messages.length,
    analyzed: presentAnalyses.length,
    feeds_touched: feedsTouched,
    subject_filter_count: filters.subject_match.length,
    sender_filter_count: filters.sender_match.length,
    since: filters.since ?? "",
    until: filters.until ?? "",
    live_pull: wantsLivePull ? "true" : "false",
    live_pull_matches: livePullPart?.matches.length ?? 0,
  });

  return NextResponse.json(response);
}
