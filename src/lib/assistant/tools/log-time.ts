/**
 * log-time — assistant tool that opens the TimeLogWidget. Trigger
 * phrases: "log time", "log hours", "track time", "/time".
 *
 * Pure widget-spec emitter; the widget itself POSTs to /api/time-entries
 * on submit (which fires `system.time_entry_recorded` analytics).
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import type { TimeLogWidgetSpec } from "@/lib/assistant/widgets/types";

const ParamSchema = z.object({
  job_code: z.string().max(64).optional(),
  hours: z.number().min(0).max(24).optional(),
  notes: z.string().max(500).optional(),
});
type Params = z.infer<typeof ParamSchema>;

interface LogTimeData {
  kind: "time_log";
}

const INTENT_RE =
  /^\s*\/?(?:log\s+(?:time|hours)|track\s+time|time\s+entry)\b\s*(.*)$/i;

export function matchLogTimeIntent(message: string): Params | null {
  const trimmed = (message ?? "").trim();
  if (!trimmed) return null;
  const m = trimmed.match(INTENT_RE);
  if (!m) return null;
  /* Lightweight free-text prefill: "log time 1.5h on WOLFPACK-AUTO".
     Best-effort — anything we don't parse, the user types in the
     widget. */
  const tail = (m[1] ?? "").trim();
  const out: Params = {};
  const hoursMatch = tail.match(/(\d+(?:\.\d+)?)\s*h(?:ours?)?\b/i);
  if (hoursMatch) out.hours = Number(hoursMatch[1]);
  const codeMatch = tail.match(/\b(?:on|for|to)\s+([A-Z0-9][A-Z0-9_\- ]{1,60})/i);
  if (codeMatch) out.job_code = codeMatch[1].trim();
  return out;
}

export const logTimeTool: ToolDef<Params, LogTimeData> = {
  name: "log_time",
  description:
    "Open the time-logging form. Trigger phrases: 'log time', 'log hours', 'track time'. Optional free-text prefill: 'log time 1.5h on WOLFPACK-AUTO'.",
  paramSchema: ParamSchema,
  capability: "assistant.use",
  matchIntent: matchLogTimeIntent,
  async handler(params, ctx): Promise<ToolResult<LogTimeData>> {
    trackEvent("assistant.widget_offered", ctx.userId, ctx.userRole, {
      widget_kind: "time_log",
      prefilled_job_code: params.job_code ? "yes" : "no",
      prefilled_hours: typeof params.hours === "number" ? "yes" : "no",
      ...(ctx.workflowId ? { workflow_id: ctx.workflowId } : {}),
    });
    const spec: TimeLogWidgetSpec = {
      kind: "time_log",
      jobCode: params.job_code,
      hours: params.hours,
      notes: params.notes,
      submitUrl: "/api/time-entries",
    };
    return {
      ok: true,
      data: { kind: "time_log" },
      answer:
        "Open the form below and log your hours. Tap a recent job code to pre-fill.",
      sources: [],
      widget: spec,
    };
  },
};

registerTool(logTimeTool);
