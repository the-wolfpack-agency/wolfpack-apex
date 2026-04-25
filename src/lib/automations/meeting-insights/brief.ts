/**
 * meeting-insights / brief — Phase 4 calendar-event brief assembler.
 *
 * Pure-ish: pulls feeds + messages + (optional) Phase 2/3 analyses out
 * of Postgres and composes a `MeetingBrief`. Returns null when no
 * enabled feed matches the event title.
 *
 * Matching policy: case-insensitive substring against any of the
 * feed's `subject_match` entries. When multiple feeds match, pick the
 * MOST-SPECIFIC one — defined as the longest matching filter
 * substring across all candidates. Ties broken deterministically by
 * the feed's slug (alphabetical, ascending) so the same event always
 * resolves to the same feed.
 *
 * Tolerance: Phase 2/3 may not have run yet on these messages, or its
 * migration may not be applied. `getAnalysesByMessageIds` returns an
 * empty map in both cases, and the brief degrades gracefully — recent
 * messages still render, action items / topics simply come up empty.
 */

import { listFeeds } from "./feeds-repo";
import { listMessagesForFeed } from "./messages-repo";
import { getAnalysesByMessageIds } from "./analyses-repo";
import { aggregateActions, aggregateThemes } from "./aggregator";
import { query } from "@/lib/db";
import type {
  ActionItem,
  BriefRecentMessage,
  BriefRecurringTopic,
  MeetingAnalysisRecord,
  MeetingBrief,
  MeetingFeed,
} from "./types";

const RECENT_MESSAGE_LIMIT = 4;

/**
 * Pick the most-specific enabled feed whose subject_match has at
 * least one substring contained in the (lowercased) event title.
 *
 * Returns null when no feed matches.
 */
export function pickFeedForEventTitle(
  feeds: MeetingFeed[],
  eventTitle: string,
): MeetingFeed | null {
  if (!eventTitle || feeds.length === 0) return null;
  const haystack = eventTitle.toLowerCase();

  let best: { feed: MeetingFeed; matchedLength: number } | null = null;
  for (const feed of feeds) {
    if (!feed.is_enabled) continue;
    let bestForFeed = 0;
    for (const filter of feed.filters.subject_match) {
      const needle = filter.trim().toLowerCase();
      if (!needle) continue;
      if (haystack.includes(needle)) {
        if (needle.length > bestForFeed) bestForFeed = needle.length;
      }
    }
    if (bestForFeed === 0) continue;
    if (
      best === null
      || bestForFeed > best.matchedLength
      || (
        bestForFeed === best.matchedLength
        && feed.slug.localeCompare(best.feed.slug) < 0
      )
    ) {
      best = { feed, matchedLength: bestForFeed };
    }
  }

  return best?.feed ?? null;
}

/** Internal — count open exceptions for a feed (Phase 4 banner). */
async function countOpenExceptions(feed_id: string): Promise<number> {
  try {
    const r = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM instinct_meeting_exceptions
        WHERE feed_id = $1
          AND status = 'open'`,
      [feed_id],
    );
    return r.rows.length === 0 ? 0 : Number(r.rows[0].n) || 0;
  } catch {
    // Table missing or transient error — never block the brief on
    // exception counts. Worst case: banner doesn't appear.
    return 0;
  }
}

/**
 * Build the brief for an event title. `attendees` and `eventStartTime`
 * are accepted for API parity with the spec; today they're not used
 * for filtering (subject substring is sufficient signal) but are
 * threaded through analytics by the API route.
 */
export async function assembleBrief(
  eventTitle: string,
  _eventStartTime: string,
  _attendees: string[],
): Promise<MeetingBrief | null> {
  const feeds = await listFeeds({ onlyEnabled: true });
  const feed = pickFeedForEventTitle(feeds, eventTitle);
  if (!feed) return null;

  const messages = await listMessagesForFeed({
    feed_id: feed.id,
    limit: RECENT_MESSAGE_LIMIT,
  });
  const messageIds = messages.map((m) => m.id);
  const analyses = await getAnalysesByMessageIds(messageIds);

  const recent_messages: BriefRecentMessage[] = messages.map((m) => {
    const a = analyses.get(m.id);
    return {
      id: m.id,
      subject: m.subject,
      received_at: m.received_at,
      summary: a?.summary ?? null,
      analyzed: a !== undefined,
    };
  });

  // Aggregate from the analyses we have. Empty when Phase 2/3 hasn't
  // run on any of these messages — that's fine, the UI handles it.
  const presentAnalyses: MeetingAnalysisRecord[] = [];
  const messageMeta = new Map<
    string,
    { received_at: string; subject: string }
  >();
  for (const m of messages) {
    messageMeta.set(m.id, { received_at: m.received_at, subject: m.subject });
    const a = analyses.get(m.id);
    if (a) presentAnalyses.push(a);
  }

  // Open action items = every action item across the recent
  // analyses, deduped. Phase 2/3 owns "completed" tracking; for
  // Phase 4 we surface every emitted item.
  const open_action_items: ActionItem[] = aggregateActions(presentAnalyses);

  const themes = aggregateThemes(presentAnalyses, messageMeta);
  const recurring_topics: BriefRecurringTopic[] = themes
    .filter((t) => t.mention_count >= 2)
    .map((t) => ({ topic: t.topic, mention_count: t.mention_count }));

  const exception_count = await countOpenExceptions(feed.id);

  return {
    feed,
    recent_messages,
    open_action_items,
    recurring_topics,
    exception_count,
  };
}
