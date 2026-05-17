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
    default:
      /* Forward-compat: silently render nothing for unknown kinds.
       * The text answer above the widget still surfaces, so the
       * user is never stuck without information. */
      return null;
  }
}
