/**
 * meeting-insights / router — pure per-message routing.
 *
 * Given an incoming message envelope and the current set of feeds,
 * pick the FIRST enabled feed whose filters match. Pure function — no
 * I/O, no side effects — so it's trivially testable in isolation.
 *
 * Match rules (mirror the Stream A spec):
 *   - sender_match: substring match against the lowercased From address
 *     (any-of). EMPTY array = matches everything.
 *   - subject_match: substring match against the lowercased Subject
 *     (any-of). EMPTY array = matches everything.
 *   - since: ISO date; only consider messages received on/after.
 *   - is_enabled: false → skip.
 *
 * Both empty arrays + no `since` → matches every message; that's the
 * "default catch-all feed" pattern.
 *
 * First-match-wins lets admins precedence-order feeds via creation
 * order: more specific feeds should be created first. We sort by
 * `created_at` ASCENDING for routing (older = higher precedence) so
 * the catch-all is naturally the last-created.
 */

import type { MeetingFeed } from "./types";

/** Slim shape the router needs from an inbound message. */
export interface RoutableMessage {
  source_message_id: string;
  subject: string;
  from_address: string;
  received_at: string;
}

export interface RouteHit {
  feed_id: string;
  feed_slug: string;
}

export function routeMessageToFeed(
  message: RoutableMessage,
  feeds: ReadonlyArray<MeetingFeed>,
): RouteHit | null {
  const subj = (message.subject ?? "").toLowerCase();
  const from = (message.from_address ?? "").toLowerCase();
  const receivedMs = parseReceivedAt(message.received_at);

  const ordered = [...feeds].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );

  for (const feed of ordered) {
    if (!feed.is_enabled) continue;
    if (!matchesFeed({ subj, from, receivedMs }, feed)) continue;
    return { feed_id: feed.id, feed_slug: feed.slug };
  }
  return null;
}

function parseReceivedAt(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function matchesFeed(
  ctx: { subj: string; from: string; receivedMs: number },
  feed: MeetingFeed,
): boolean {
  const senders = feed.filters.sender_match ?? [];
  const subjects = feed.filters.subject_match ?? [];

  if (senders.length > 0) {
    const hit = senders.some((s) => ctx.from.includes(s.toLowerCase()));
    if (!hit) return false;
  }
  if (subjects.length > 0) {
    const hit = subjects.some((s) => ctx.subj.includes(s.toLowerCase()));
    if (!hit) return false;
  }
  if (feed.filters.since) {
    const sinceMs = Date.parse(feed.filters.since);
    if (Number.isFinite(sinceMs) && ctx.receivedMs < sinceMs) {
      return false;
    }
  }
  return true;
}
