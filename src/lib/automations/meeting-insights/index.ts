/**
 * meeting-insights — multi-feed org-shared recurring-meeting ingest.
 *
 * Registers a SINGLE entry in the automations registry whose
 * `inbox_filters` are computed dynamically from the union of every
 * enabled `instinct_meeting_feeds` row. Per-message routing in
 * `./router.ts` then assigns each match to a specific feed.
 *
 * Two streams build against this contract:
 *   - Stream A (this file + ingest + router + APIs + UI): how messages
 *     get from Graph into rows, plus the dashboard.
 *   - Stream B (parser-email-body, parser-attachments): body/HTML text
 *     extraction + .docx/.pdf attachment text. Hot-swapped via dynamic
 *     import in ingest.ts so this module ships independently.
 *
 * The `email` parser registered here is a pass-through stub — real
 * orchestration lives in `ingest.ts` (the inbox poller calls
 * ingestMeetingMessage directly because the orchestration is
 * message-shaped, not artifact-shaped). The parser map entry exists so
 * `isMessageLevelIngest()` and the registry's source_type listings
 * stay accurate.
 */

import type { AutomationDefinition, ParseResult } from "@/lib/automations/types";
import { unionEnabledFilters } from "./feeds-repo";

export const meetingInsights: AutomationDefinition = {
  id: "meeting-insights",
  name: "Meeting Insights",
  // Owner label is generic — every team has someone running recurring
  // meetings. Ops + CTO are the primary configurators.
  owner_label: "Ops",
  description:
    "Multi-feed ingest for recurring meeting threads (stand-ups, " +
    "vendor briefings, weekly partner updates). Each feed watches a " +
    "matching set of senders/subjects; routed messages land as searchable " +
    "rows with body text + attachment extracts.",
  // Window is informational here — meeting-insights doesn't run a
  // class-style horizon, but the field is required by the registry.
  active_window_days: { min: -30, max: 30 },
  // STATIC fallback. Empty by default so a fresh deploy with zero feeds
  // doesn't accidentally ingest the entire mailbox. The dynamic loader
  // below is the real source of truth.
  inbox_filters: {
    sender_match: [],
    subject_match: [],
  },
  // Dynamic loader — the inbox-poller awaits this once per tick to
  // build a Graph $filter that's the UNION of all enabled feeds. New
  // / edited feeds take effect on the next tick without a redeploy.
  loadInboxFilters: async () => {
    return unionEnabledFilters();
  },
  parsers: {
    // Stub parser — never actually invoked because meeting-insights
    // ingests at the MESSAGE level (see isMessageLevelIngest in
    // inbox-poller.ts). Registered so type-level guards pass and the
    // registry metadata projection lists the source type.
    email: async (): Promise<ParseResult> => ({
      ok: false,
      source_type: "email",
      error:
        "meeting-insights ingests at the message level via " +
        "ingestMeetingMessage; this stub should never be invoked",
      exception_kind: "parse_failure",
    }),
  },
};
