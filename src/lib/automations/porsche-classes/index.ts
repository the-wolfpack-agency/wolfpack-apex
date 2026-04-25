/**
 * porsche-classes — Porsche Academy BA101/102 class registrations + summaries.
 *
 * Registers Alicia's automation in the Automations registry. Two streams
 * shipped this in parallel:
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

export const porscheClasses: AutomationDefinition = {
  id: "porsche-classes",
  name: "Porsche BA101 / BA102",
  // Alicia owns this work day-to-day.
  owner_label: "alicia@thewolfpack.agency",
  description:
    "Daily ingest of Porsche Brand Ambassador 101/102 registration deltas + " +
    "coordinator / instructor / survey rollups. Replaces the Mon/Fri manual " +
    "report Alicia builds by hand.",
  // 60-day forward horizon plus a 7-day backward grace period covers the
  // active class window — anything outside is informational only and does
  // not need to appear in the digest.
  active_window_days: { min: -7, max: 60 },
  inbox_filters: {
    sender_match: [
      "porsche-academy-notification@porsche.de",
      "notifications@cognitoforms.com",
    ],
    subject_match: [
      "Scheduled Report Notification",
      "Coordinator Class Report",
      "Instructor Class Report",
    ],
  },
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
