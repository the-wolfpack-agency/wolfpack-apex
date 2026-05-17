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
}

export function ChatWidget({ spec }: ChatWidgetProps) {
  if (!spec || typeof spec !== "object") return null;
  switch (spec.kind) {
    case "calendar":
      return <CalendarWidget spec={spec} />;
    case "email_thread":
      return <EmailThreadWidget spec={spec} />;
    case "task_list":
      return <TaskListWidget spec={spec} />;
    case "good_morning":
      return <GoodMorningWidget spec={spec} />;
    default:
      /* Forward-compat: silently render nothing for unknown kinds.
       * The text answer above the widget still surfaces, so the
       * user is never stuck without information. */
      return null;
  }
}
