/**
 * Audit hook for every Azure Cognitive Services call.
 *
 * Writes an instinct_azure_calls row per call regardless of outcome
 * (succeeded / failed / rate_limited / not_configured) so we never
 * lose the cost-tracking signal. Best-effort: if the DB itself is
 * down we swallow the error rather than fail the request handler —
 * the caller still gets the Azure result. The trade-off is one
 * potentially-missed audit row vs. a failed user request; we choose
 * the former.
 *
 * Also fires a typed analytics event so the learning loop sees the
 * call in the events stream even when the audit table is unreachable.
 */

import { writeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import type { AzureResult } from "./client";

export interface AzureCallContext {
  service: "computer_vision" | "form_recognizer";
  operation: string;
  triggeredBy: string | null;
  triggeredByRole: string | null;
  documentId?: string | null;
  requestBytes: number;
}

export async function recordAzureCall<T>(
  ctx: AzureCallContext,
  result: AzureResult<T>,
  responseChars: number,
): Promise<void> {
  const status: "succeeded" | "failed" | "rate_limited" | "not_configured" = result.ok
    ? "succeeded"
    : result.error.code === "rate_limited"
      ? "rate_limited"
      : result.error.code === "not_configured"
        ? "not_configured"
        : "failed";

  try {
    await writeQuery(
      `INSERT INTO instinct_azure_calls
         (service, operation, triggered_by, document_id, status,
          http_status, latency_ms, request_bytes, response_chars,
          error_code, error_detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        ctx.service,
        ctx.operation,
        ctx.triggeredBy,
        ctx.documentId ?? null,
        status,
        result.httpStatus ?? null,
        result.latencyMs,
        ctx.requestBytes,
        responseChars,
        result.ok ? null : result.error.code,
        result.ok ? null : result.error.detail.slice(0, 400),
      ],
      { expectRows: 0 },
    );
  } catch {
    /* DB write failed — don't poison the user request. Analytics
       event below is the fallback signal. */
  }

  try {
    await trackEvent(
      result.ok
        ? ctx.service === "computer_vision"
          ? "azure.vision_ocr_succeeded"
          : "azure.form_recognizer_succeeded"
        : ctx.service === "computer_vision"
          ? "azure.vision_ocr_failed"
          : "azure.form_recognizer_failed",
      ctx.triggeredBy ?? "system",
      ctx.triggeredByRole ?? "system",
      {
        operation: ctx.operation,
        latency_ms: result.latencyMs,
        request_bytes: ctx.requestBytes,
        response_chars: responseChars,
        ...(result.ok ? {} : { reason: result.error.code }),
      },
    );
  } catch {
    /* analytics is best-effort */
  }
}
