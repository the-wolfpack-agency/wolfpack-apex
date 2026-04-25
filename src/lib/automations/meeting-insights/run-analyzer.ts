/**
 * meeting-insights / run-analyzer — orchestrate one analyzer pass for
 * one message: fetch parsed text → call Claude Haiku → upsert →
 * triple-write fanout.
 *
 * Hard rules (per memory feedback_no_silent_data_loss):
 *   - Always lands an analysis row, even on error. Status='error' rows
 *     are visible in the UI so operators can see *why* analysis failed.
 *   - Never throws. Errors come back as the persisted row.
 *   - Idempotent: same (message, version) re-runs are no-ops on UPSERT
 *     (we still touch the row so the dashboard knows it was retried).
 */

import { getMessage, listAttachmentsForMessage } from "./messages-repo";
import { upsertAnalysis } from "./analyses-repo";
import { analyzeMessage } from "./analyzer";
import { ANALYZER_VERSION } from "./analyzer/types";
import type { MeetingAnalysisRecord } from "./analyses-repo";
import { fanoutAnalysisToSecondaries } from "./triple-write";

export interface RunAnalyzerArgs {
  feed_id: string;
  message_id: string;
  /** Override the version (for testing or forced regeneration). */
  analyzer_version?: string;
}

export interface RunAnalyzerOutcome {
  ok: boolean;
  record: MeetingAnalysisRecord | null;
  error?: string;
}

/**
 * Run the analyzer for one message. Fire-and-forget safe — wrap in
 * `void runAnalyzer(...)` from ingest to avoid blocking the poll cycle.
 */
export async function runAnalyzer(
  args: RunAnalyzerArgs,
): Promise<RunAnalyzerOutcome> {
  const version = args.analyzer_version ?? ANALYZER_VERSION;

  let message;
  try {
    message = await getMessage({
      feed_id: args.feed_id,
      message_id: args.message_id,
    });
  } catch (err) {
    return {
      ok: false,
      record: null,
      error: `analyzer_fetch_message_failed: ${(err as Error).message}`,
    };
  }
  if (!message) {
    return {
      ok: false,
      record: null,
      error: "message_not_found",
    };
  }

  let attachments: Array<{ filename: string; extracted_text: string | null }>;
  try {
    const rows = await listAttachmentsForMessage(args.message_id);
    attachments = rows.map((r) => ({
      filename: r.filename,
      extracted_text: r.extracted_text,
    }));
  } catch {
    attachments = [];
  }

  const result = await analyzeMessage({
    subject: message.subject,
    from_address: message.from_address,
    from_name: message.from_name,
    received_at: message.received_at,
    body_text: message.body_text,
    attachments,
  });

  let record: MeetingAnalysisRecord | null = null;
  try {
    record = await upsertAnalysis({
      message_id: args.message_id,
      analyzer_version: version,
      analysis: result.analysis,
      raw_llm_response: result.raw_llm_response,
      model: result.model,
      tokens_used: result.tokens_used,
      status: result.status,
      error_detail: result.error_detail,
    });
  } catch (err) {
    return {
      ok: false,
      record: null,
      error: `analyzer_upsert_failed: ${(err as Error).message}`,
    };
  }

  // Triple-write fanout, only on success — error / partial rows have
  // empty content so there's nothing useful to embed or graph.
  if (record && record.status === "success") {
    void fanoutAnalysisToSecondaries({
      message_id: record.message_id,
      feed_id: args.feed_id,
      received_at: message.received_at,
      subject: message.subject,
      topics: record.topics,
      action_items: record.action_items,
      summary_text: buildSummaryText(record),
    });
  }

  return {
    ok: result.status !== "error",
    record,
    error: result.status === "error" ? result.error_detail : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Summary builder                                                     */
/* ------------------------------------------------------------------ */

/**
 * Compose a single human-readable summary string from the analysis
 * fields. Used as the Qdrant payload body and as the Neo4j message
 * description.
 */
export function buildSummaryText(record: MeetingAnalysisRecord): string {
  const parts: string[] = [];
  if (record.topics.length > 0) {
    parts.push(`Topics: ${record.topics.join(", ")}`);
  }
  if (record.decisions.length > 0) {
    parts.push(
      `Decisions: ${record.decisions.map((d) => d.summary).join(" | ")}`,
    );
  }
  if (record.action_items.length > 0) {
    parts.push(
      `Action items: ${record.action_items.map((a) => a.description).join(" | ")}`,
    );
  }
  if (record.blockers.length > 0) {
    parts.push(
      `Blockers: ${record.blockers.map((b) => b.description).join(" | ")}`,
    );
  }
  return parts.join("\n");
}
