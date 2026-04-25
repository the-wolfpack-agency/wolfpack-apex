/**
 * Phase 5 escape hatch — query the user's Outlook inbox LIVE for
 * messages matching ad-hoc subject/sender substrings, without
 * requiring a saved feed and without ingesting / persisting / analyzing.
 *
 * Use cases:
 *   - "what's in my inbox from `nick@thewolfpack.agency` about pricing
 *     in the last 30 days?"
 *   - one-off audit before deciding whether to create a recurring feed
 *
 * Cost model: ONE Microsoft Graph delta call per request (cheap), no
 * LLM, no DB writes. Returns metadata + body preview so the operator
 * can scan the matches before spending tokens on real analysis.
 *
 * Auth: caller must already have meetings.manage. Token retrieval
 * uses the standard getValidToken/dual-anchor lookup so the
 * connected_by-vs-user_email shenanigans we sorted earlier all
 * apply.
 */

import { listMailDelta, type GraphMailMessage } from "@/lib/ms-graph/client";

export interface LivePullFilters {
  /** Subject substring matchers (case-insensitive, ANY-of). Empty = all. */
  subject_match: string[];
  /** Sender substring matchers (case-insensitive, ANY-of). Empty = all. */
  sender_match: string[];
  /** ISO date — only messages received on or after this. */
  since?: string;
  /** ISO date — only messages received on or before this. */
  until?: string;
  /** Hard cap on returned matches. Defaults to 50. */
  limit?: number;
}

export interface LivePullMatch {
  /** Microsoft Graph message id — stable, used to deep-link into Outlook. */
  source_message_id: string;
  subject: string;
  from_address: string;
  from_name: string | null;
  received_at: string;
  /** Short body snippet from Graph's bodyPreview field — already plain text. */
  body_preview: string;
  has_attachments: boolean;
}

export interface LivePullResult {
  /** True when the user has no MS Graph token connected. */
  skipped: boolean;
  skipped_reason?: "no_user_connected" | "no_valid_token";
  /** How many messages Graph returned this delta page. */
  inbox_seen: number;
  /** How many of those passed the typed filters + date range. */
  matched: LivePullMatch[];
  /** Whether the limit was hit (more matches likely exist). */
  truncated: boolean;
}

function lc(s: string | null | undefined): string {
  return (s ?? "").toLowerCase();
}

function matchesFilters(m: GraphMailMessage, f: LivePullFilters): boolean {
  if (f.subject_match.length > 0) {
    const subj = lc(m.subject);
    if (!f.subject_match.some((s) => subj.includes(s.toLowerCase()))) return false;
  }
  if (f.sender_match.length > 0) {
    const addr = lc(m.from?.emailAddress?.address);
    if (!f.sender_match.some((s) => addr.includes(s.toLowerCase()))) return false;
  }
  return true;
}

function inDateRange(m: GraphMailMessage, f: LivePullFilters): boolean {
  if (!m.receivedDateTime) return true;
  const t = new Date(m.receivedDateTime).getTime();
  if (f.since && t < new Date(f.since).getTime()) return false;
  if (f.until && t > new Date(f.until).getTime()) return false;
  return true;
}

/**
 * Run a one-shot inbox scan against typed filters. NEVER persists
 * anything — caller decides what to do with the matches (eg show in
 * UI, offer "save as feed", etc.).
 */
export async function livePullInbox(args: {
  userId: string;
  filters: LivePullFilters;
}): Promise<LivePullResult> {
  const limit = args.filters.limit ?? 50;
  let items: GraphMailMessage[] = [];
  try {
    /* No deltaLink — we want a fresh scan against the entire inbox.
       For phase-1 ergonomics this returns the most-recent slice; if
       we ever want true full-history we'd drain nextLinks. */
    const r = await listMailDelta(args.userId);
    items = r.items;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "no_token") {
      return { skipped: true, skipped_reason: "no_user_connected", inbox_seen: 0, matched: [], truncated: false };
    }
    throw err;
  }

  const live = items.filter((m) => !m["@removed"]);
  const matched: LivePullMatch[] = [];
  for (const m of live) {
    if (!matchesFilters(m, args.filters)) continue;
    if (!inDateRange(m, args.filters)) continue;
    matched.push({
      source_message_id: m.id,
      subject: m.subject ?? "(no subject)",
      from_address: m.from?.emailAddress?.address ?? "",
      from_name: m.from?.emailAddress?.name ?? null,
      received_at: m.receivedDateTime ?? new Date().toISOString(),
      body_preview: (m as { bodyPreview?: string }).bodyPreview ?? "",
      has_attachments: Boolean((m as { hasAttachments?: boolean }).hasAttachments),
    });
    if (matched.length >= limit) break;
  }

  return {
    skipped: false,
    inbox_seen: live.length,
    matched,
    truncated: matched.length >= limit && live.length > matched.length,
  };
}
