/**
 * porsche-classes — Porsche Academy BA101/102 class registrations + summaries.
 *
 * Registers the Porsche Academy class-ops automation in the Automations
 * registry. Two streams shipped this in parallel:
 *   - Stream A: ingest orchestrator, xlsx parser, delta engine, dashboard,
 *     changes UI, exception queue, MS Graph inbox poller.
 *   - Stream B: cognito coordinator + instructor parsers, survey stub,
 *     summary assembler, summary UI, copy-to-clipboard / JSON download.
 *
 * Adding the next per-source parser or replacing the survey stub is the
 * intended extension path: drop a new file under this directory, add it
 * to `parsers` below, ship.
 */

import type { AutomationDefinition } from "@/lib/automations/types";
import { parseXlsx } from "./parser-xlsx";
import { parseCognitoCoordinator } from "./parser-cognito-coordinator";
import { parseCognitoInstructor } from "./parser-cognito-instructor";
import { parseSurvey } from "./parser-survey";
import { assemblePorscheClassSummary } from "./summary-assembler";
import {
  getInboxFilters as loadInboxFiltersFromConfig,
  DEFAULT_INBOX_FILTERS,
} from "./config-repo";

/**
 * Dynamic loader for the inbox poller. Reads the operator-managed row
 * from `instinct_automation_porsche_config` (key='inbox_filters') and
 * falls back to the static defaults declared in the AutomationDefinition
 * below. Wired the same way meeting-insights does it
 * (`unionEnabledFilters`) so the inbox-poller's
 * `resolveActiveInboxFilters` calls this once per tick — operator edits
 * to the wizard apply on the NEXT poll, no redeploy.
 *
 * Soft-fails to defaults on any DB error so a transient outage doesn't
 * break ingest entirely (matches the inbox-poller's existing graceful-
 * degradation contract).
 */
export async function loadInboxFilters(): Promise<{
  sender_match: string[];
  subject_match: string[];
}> {
  try {
    const filters = await loadInboxFiltersFromConfig();
    /* Empty arrays from a half-saved config row would silently disable
       ingest. If both lists are empty, prefer the static defaults so a
       brand-new tenant still receives traffic. */
    if (
      filters.sender_match.length === 0 &&
      filters.subject_match.length === 0
    ) {
      return DEFAULT_INBOX_FILTERS;
    }
    return filters;
  } catch (err) {
    console.warn(
      `[porsche-classes] loadInboxFilters fell back to defaults: ${(err as Error).message}`,
    );
    return DEFAULT_INBOX_FILTERS;
  }
}

export const porscheClasses: AutomationDefinition = {
  id: "porsche-classes",
  name: "Porsche BA101 / BA102",
  // Process owner — the team member responsible for the workflow.
  owner_label: "Program Director",
  description:
    "Daily ingest of Porsche Brand Ambassador 101/102 registration " +
    "deltas plus coordinator / instructor / survey rollups. Replaces " +
    "the Mon/Fri manual class-summary process.",
  // 60-day forward horizon plus a 7-day backward grace period covers the
  // active class window — anything outside is informational only and does
  // not need to appear in the digest.
  active_window_days: { min: -7, max: 60 },
  // Static fallback — used by callers that don't await loadInboxFilters
  // (any direct read of the AutomationDefinition) and as the safety-net
  // when the dynamic loader throws. Keep in sync with
  // DEFAULT_INBOX_FILTERS in ./config-repo.ts.
  inbox_filters: {
    sender_match: [
      "porsche-academy-notification@porsche.de",
      "notifications@cognitoforms.com",
      // Internal-domain testing: any email from a wolfpack address that
      // also matches a subject below counts. Lets the program team
      // verify ingest end-to-end without depending on the Porsche
      // mailbox being set up. Production senders above remain primary;
      // remove this line once the Porsche-side forwarding is wired.
      "@thewolfpack.agency",
      /* Wildcard fallback: every email address contains "@", so this
         pattern matches all senders. The subject_match list is the
         actual gate — only emails whose subject hits one of the
         distinctive Porsche / Cognito / survey patterns below ingest.
         Used because the survey-vendor sender isn't yet known and we
         want ingestion to work over the weekend. Tighten this when the
         vendor address surfaces. */
      "@",
    ],
    subject_match: [
      "Scheduled Report Notification",
      "Coordinator Class Report",
      "Instructor Class Report",
      "Change Management Plan",
      "Brand Ambassador",
      /* Survey vendor xlsx — distinctive enough that subject-only is
         safe. Pattern: "Survey Data PCBA 101 Pendry March 23-27th". */
      "Survey Data PCBA",
    ],
  },
  // Dynamic loader: wizard-managed filter row wins when present, static
  // fallback above kicks in when no row exists / DB unreachable.
  loadInboxFilters,
  parsers: {
    porsche_xlsx: parseXlsx,
    cognito_coordinator: parseCognitoCoordinator,
    cognito_instructor: parseCognitoInstructor,
    survey: parseSurvey,
  },
  assemble_summary: assemblePorscheClassSummary,
};

export {
  parseXlsx,
  parseCognitoCoordinator,
  parseCognitoInstructor,
  parseSurvey,
  assemblePorscheClassSummary,
};
