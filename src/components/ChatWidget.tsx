/**
 * ChatWidget — discriminator-based dispatcher for inline chat widgets.
 *
 * The Assistant returns a WidgetSpec on certain tool results (calendar,
 * email thread, task list, dashboard chart, …). This component reads
 * the `kind` discriminator and renders the right widget. Adding a new
 * widget kind = add a `kind` to WidgetSpec + a case here + a renderer.
 *
 * Defensive: unknown kinds render nothing (rather than crash the chat
 * message) so a backend that ships a new widget kind before a
 * frontend deploy doesn't break user-visible behavior.
 */

"use client";

import type { WidgetSpec } from "@/lib/assistant/widgets/types";
import { CalendarWidget } from "@/components/widgets/CalendarWidget";
import { EmailThreadWidget } from "@/components/widgets/EmailThreadWidget";
import { TaskListWidget } from "@/components/widgets/TaskListWidget";
import { GoodMorningWidget } from "@/components/widgets/GoodMorningWidget";
import { DmsInventoryWidget } from "@/components/widgets/DmsInventoryWidget";
import { VercelDeploymentsWidget } from "@/components/widgets/VercelDeploymentsWidget";
import { GithubItemsWidget } from "@/components/widgets/GithubItemsWidget";
import { CrossToolInsightsWidget } from "@/components/widgets/CrossToolInsightsWidget";
import { IntegrationsListWidget } from "@/components/widgets/IntegrationsListWidget";
import { SearchResultsWidget } from "@/components/widgets/SearchResultsWidget";
import { WeatherWidget } from "@/components/widgets/WeatherWidget";
import { HeadlinesWidget } from "@/components/widgets/HeadlinesWidget";
import { FxWidget } from "@/components/widgets/FxWidget";
import { UploadToBrainWidget } from "@/components/widgets/UploadToBrainWidget";
import { MeetingPrepWidget } from "@/components/widgets/MeetingPrepWidget";
import { FeedbackWidget } from "@/components/widgets/FeedbackWidget";
import { TimeLogWidget } from "@/components/widgets/TimeLogWidget";
import { ScanReceiptWidget } from "@/components/widgets/ScanReceiptWidget";
import { ScanInvoiceWidget } from "@/components/widgets/ScanInvoiceWidget";
import { ScanHrDocWidget } from "@/components/widgets/ScanHrDocWidget";
import { ClarifyWidget } from "@/components/widgets/ClarifyWidget";

export interface ChatWidgetProps {
  spec: WidgetSpec;
  /** Per-turn correlation id. Forwarded to every renderer so its
   *  client-side interaction analytics events join the same funnel
   *  as the originating chat() turn. */
  workflowId?: string;
}

export function ChatWidget({ spec, workflowId }: ChatWidgetProps) {
  if (!spec || typeof spec !== "object") return null;
  switch (spec.kind) {
    case "calendar":
      return <CalendarWidget spec={spec} workflowId={workflowId} />;
    case "email_thread":
      return <EmailThreadWidget spec={spec} workflowId={workflowId} />;
    case "task_list":
      return <TaskListWidget spec={spec} workflowId={workflowId} />;
    case "good_morning":
      return <GoodMorningWidget spec={spec} workflowId={workflowId} />;
    case "dms_inventory":
      return <DmsInventoryWidget spec={spec} workflowId={workflowId} />;
    case "vercel_deployments":
      return <VercelDeploymentsWidget spec={spec} workflowId={workflowId} />;
    case "github_items":
      return <GithubItemsWidget spec={spec} workflowId={workflowId} />;
    case "cross_tool_insights":
      return <CrossToolInsightsWidget spec={spec} workflowId={workflowId} />;
    case "integrations_list":
      return <IntegrationsListWidget spec={spec} workflowId={workflowId} />;
    case "search_results":
      return <SearchResultsWidget spec={spec} workflowId={workflowId} />;
    case "weather":
      return <WeatherWidget spec={spec} workflowId={workflowId} />;
    case "headlines":
      return <HeadlinesWidget spec={spec} workflowId={workflowId} />;
    case "fx":
      return <FxWidget spec={spec} workflowId={workflowId} />;
    case "upload_to_brain":
      return <UploadToBrainWidget spec={spec} workflowId={workflowId} />;
    case "meeting_prep":
      return <MeetingPrepWidget spec={spec} workflowId={workflowId} />;
    case "feedback":
      return <FeedbackWidget spec={spec} workflowId={workflowId} />;
    case "time_log":
      /* Was missing from the switch since TimeLogWidget shipped on
         2026-05-20 — the log_time tool emitted the spec but the
         renderer silently dropped it. Fixed alongside the
         scan_receipt rollout. */
      return <TimeLogWidget spec={spec} workflowId={workflowId} />;
    case "scan_receipt":
      return <ScanReceiptWidget spec={spec} workflowId={workflowId} />;
    case "scan_invoice":
      return <ScanInvoiceWidget spec={spec} workflowId={workflowId} />;
    case "scan_hr_doc":
      return <ScanHrDocWidget spec={spec} workflowId={workflowId} />;
    case "clarify":
      return <ClarifyWidget spec={spec} workflowId={workflowId} />;
    default:
      /* Forward-compat: silently render nothing for unknown kinds.
       * The text answer above the widget still surfaces, so the
       * user is never stuck without information. */
      return null;
  }
}
