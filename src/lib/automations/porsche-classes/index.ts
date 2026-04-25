/**
 * porsche-classes — registers the BA101/102 automation in the registry.
 *
 * Stream A (this file) registers:
 *   - parsers.porsche_xlsx       (./parser-xlsx)
 * and provides automation metadata (id, name, owner_label, filters,
 * active_window_days).
 *
 * Stream B will follow up with:
 *   - parsers.cognito_coordinator (./parser-cognito-coordinator)
 *   - parsers.cognito_instructor  (./parser-cognito-instructor)
 *   - parsers.survey              (./parser-survey)
 *   - assemble_summary            (./summary-assembler)
 *
 * Stream B's contract: the file paths above are reserved for them. They
 * either ADD entries to `parsers` and SET `assemble_summary` directly on
 * the exported AutomationDefinition, or ship a follow-up that mutates
 * the registry post-import. Either way the build stays green when their
 * files are absent (we register only what we own here).
 */

import type { AutomationDefinition } from "@/lib/automations/types";
import { parseXlsx } from "./parser-xlsx";

export const porscheClasses: AutomationDefinition = {
  id: "porsche-classes",
  name: "Porsche BA101 / BA102",
  // Alicia Zulker — Program Director — owns this work day-to-day.
  owner_label: "alicia@thewolfpack.agency",
  description:
    "Daily ingest of Porsche Brand Ambassador 101/102 registration deltas + " +
    "coordinator / instructor / survey rollups. Replaces the Mon/Fri manual " +
    "report Alicia builds by hand.",
  // 30 / 60-day window covers the active class horizon — anything
  // outside this is informational only and does not need a digest.
  active_window_days: { min: -7, max: 60 },
  inbox_filters: {
    // Subject substring on Cornerstone's standard "Scheduled Report
    // Notification" plus the daily "PCNA Training Report" attachment
    // hint. Both must pass `String.includes` to count.
    sender_match: ["porsche-academy-notification@porsche.de"],
    subject_match: ["Scheduled Report Notification"],
  },
  parsers: {
    porsche_xlsx: parseXlsx,
    // cognito_coordinator / cognito_instructor / survey: registered by
    // Stream B in a follow-up PR. Until then, the inbox poller filters
    // those source_types out and the summary assembler is a no-op.
  },
  // assemble_summary: provided by Stream B in a follow-up PR.
};
