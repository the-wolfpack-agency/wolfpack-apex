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

import type { GraphMailMessage } from "@/lib/ms-graph/client";
import { getValidToken } from "@/lib/microsoft-graph";

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
  /** True when the call short-circuited (no token, Graph error, etc). */
  skipped: boolean;
  /** Either a known reason ('no_user_connected' / 'no_valid_token') or
      a free-form fallback like 'graph_429' / a fetch error message. */
  skipped_reason?: string;
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
 * Run a one-shot inbox scan against typed filters. Uses Microsoft
 * Graph's `$search` + `$filter` so the matching happens server-side
 * — avoids draining tens of thousands of messages just to throw
 * away the irrelevant ones (which busted Vercel's 10s function
 * limit on the previous delta-drain implementation).
 *
 * NEVER persists anything — caller decides what to do with the
 * matches (show in UI, offer "save as feed", etc.).
 */
export async function livePullInbox(args: {
  userId: string;
  filters: LivePullFilters;
}): Promise<LivePullResult> {
  const limit = Math.min(args.filters.limit ?? 50, 100);
  const token = await getValidToken(args.userId);
  if (!token) {
    return {
      skipped: true,
      skipped_reason: "no_user_connected",
      inbox_seen: 0,
      matched: [],
      truncated: false,
    };
  }

  /* Build a Graph $search KQL clause. Format per MS docs:
     $search="from:nick@thewolfpack.agency"   (plain value, no inner quotes)
     $search="subject:PCNA"
     For multi-term values (e.g. names with spaces) the value can be
     wrapped in single quotes: subject:'PCNA Weekly'. Multiple terms
     are joined with AND/OR. The OUTER value passed to $search is one
     string; URLSearchParams URL-encodes it as needed. */
  const kqlValue = (s: string) =>
    /[\s\-]/.test(s) ? `'${s.replace(/'/g, "")}'` : s;
  const senderTerms = args.filters.sender_match
    .map((s) => `from:${kqlValue(s)}`)
    .join(" OR ");
  const subjectTerms = args.filters.subject_match
    .map((s) => `subject:${kqlValue(s)}`)
    .join(" OR ");
  let searchClause = "";
  if (senderTerms && subjectTerms) {
    searchClause = `(${senderTerms}) AND (${subjectTerms})`;
  } else if (senderTerms) {
    searchClause = senderTerms;
  } else if (subjectTerms) {
    searchClause = subjectTerms;
  }

  const url = new URL("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages");
  url.searchParams.set("$top", String(limit));
  url.searchParams.set(
    "$select",
    "id,subject,bodyPreview,from,receivedDateTime,hasAttachments",
  );
  if (searchClause) {
    /* Graph wants the $search value wrapped in double quotes. Set the
       raw string here — URLSearchParams handles encoding. */
    url.searchParams.set("$search", `"${searchClause}"`);
  } else {
    /* No filters typed — fall back to most-recent N. */
    url.searchParams.set("$orderby", "receivedDateTime desc");
  }

  let items: GraphMailMessage[] = [];
  try {
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        ConsistencyLevel: "eventual", // required when using $search
      },
    });
    if (res.status === 401) {
      return {
        skipped: true,
        skipped_reason: "no_valid_token",
        inbox_seen: 0,
        matched: [],
        truncated: false,
      };
    }
    if (!res.ok) {
      return {
        skipped: true,
        skipped_reason: `graph_${res.status}`,
        inbox_seen: 0,
        matched: [],
        truncated: false,
      };
    }
    const body = (await res.json()) as { value?: GraphMailMessage[] };
    items = body.value ?? [];
  } catch (err) {
    return {
      skipped: true,
      skipped_reason: (err as Error).message,
      inbox_seen: 0,
      matched: [],
      truncated: false,
    };
  }

  /* Graph's $search is approximate — apply the typed substring rules
     locally to belt-and-suspenders. Also apply the date range, which
     can't be combined with $search server-side. */
  const matched: LivePullMatch[] = [];
  for (const m of items) {
    if (m["@removed"]) continue;
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
    inbox_seen: items.length,
    matched,
    truncated: matched.length >= limit && items.length > matched.length,
  };
}
