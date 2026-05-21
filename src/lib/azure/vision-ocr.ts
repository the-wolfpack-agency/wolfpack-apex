/**
 * Azure Computer Vision READ-API wrapper.
 *
 * Powers the brain-extractor's `kind=image` path that previously fell
 * through to status='skipped'. With AZURE_VISION_ENDPOINT + KEY set,
 * brain ingest now OCRs PNG/JPEG/PDF/TIFF screenshots and lands the
 * extracted text in instinct_brain_documents.extracted_chars + the
 * chunker, just like a PDF or DOCX would.
 *
 * Free-tier quota: Computer Vision S1 = 5,000 transactions/month.
 * Each call audits to instinct_azure_calls so finance can forecast
 * before the meter exhausts.
 *
 * API version pinned to v3.2 (`vision/v3.2/read/analyze`) — the v4
 * Image Analysis endpoint isn't yet GA in all Azure regions and
 * changes the response shape. Swap when v4 lands GA + the free meter
 * covers it.
 */

import { resolveAzureCreds, postAzure, pollAzureOperation } from "./client";
import { recordAzureCall, type AzureCallContext } from "./audit";
import type { AzureResult } from "./client";

/** Cap on the bytes we'll send to Azure per call. Computer Vision READ
 *  enforces 4 MB; we cap at 3.5 MB to leave headroom. */
export const VISION_MAX_BYTES = 3.5 * 1024 * 1024;

interface ReadResultLine {
  text?: string;
}
interface ReadResultPage {
  lines?: ReadResultLine[];
  width?: number;
  height?: number;
  unit?: string;
}
interface ReadOperationResponse {
  status?: string;
  analyzeResult?: {
    readResults?: ReadResultPage[];
  };
}

export interface VisionOcrSuccess {
  ok: true;
  text: string;
  pages: number;
  /** True if the response had readResults pages but ZERO text lines —
   *  callers can label these "image had no extractable text" rather
   *  than the generic empty. */
  emptyImage: boolean;
}
export interface VisionOcrFailure {
  ok: false;
  reason:
    | "not_configured"
    | "too_large"
    | "rate_limited"
    | "forbidden"
    | "bad_request"
    | "unavailable"
    | "polling_timeout"
    | "internal";
  detail: string;
}
export type VisionOcrResult = VisionOcrSuccess | VisionOcrFailure;

export function isVisionConfigured(): boolean {
  return resolveAzureCreds("vision") !== null;
}

export interface OcrOptions {
  /** Audit context — who triggered the OCR + optional brain doc id. */
  triggeredBy: string | null;
  triggeredByRole: string | null;
  documentId?: string | null;
  /** image/png, image/jpeg, application/pdf, image/tiff. Defaults to
   *  application/octet-stream which Computer Vision will sniff. */
  contentType?: string;
}

export async function ocrImage(
  buffer: Buffer,
  opts: OcrOptions,
): Promise<VisionOcrResult> {
  if (buffer.length > VISION_MAX_BYTES) {
    return {
      ok: false,
      reason: "too_large",
      detail: `image ${buffer.length} bytes exceeds Vision cap ${VISION_MAX_BYTES} bytes`,
    };
  }
  const creds = resolveAzureCreds("vision");
  if (!creds) {
    return {
      ok: false,
      reason: "not_configured",
      detail: "AZURE_VISION_ENDPOINT/KEY (or AZURE_COGNITIVE_*) not set",
    };
  }

  const ctx: AzureCallContext = {
    service: "computer_vision",
    operation: "read",
    triggeredBy: opts.triggeredBy,
    triggeredByRole: opts.triggeredByRole,
    documentId: opts.documentId ?? null,
    requestBytes: buffer.length,
  };

  const post = await postAzure(creds, "vision/v3.2/read/analyze", {
    body: buffer,
    contentType: opts.contentType ?? "application/octet-stream",
  });
  if (!post.ok) {
    await recordAzureCall(ctx, post, 0);
    return mapFailure(post.error.code, post.error.detail);
  }

  const poll = await pollAzureOperation<ReadOperationResponse>(
    creds,
    post.value.operationLocation,
    { intervalMs: 750, maxAttempts: 40 },
  );
  if (!poll.ok) {
    await recordAzureCall(ctx, poll, 0);
    return mapFailure(poll.error.code, poll.error.detail);
  }

  const pages = poll.value.analyzeResult?.readResults ?? [];
  const lines: string[] = [];
  for (const p of pages) {
    for (const l of p.lines ?? []) {
      const t = (l.text ?? "").trim();
      if (t) lines.push(t);
    }
  }
  const text = lines.join("\n").trim();
  await recordAzureCall(ctx, poll, text.length);

  if (!text) {
    return { ok: true, text: "", pages: pages.length, emptyImage: true };
  }
  return { ok: true, text, pages: pages.length, emptyImage: false };
}

function mapFailure(
  code: string,
  detail: string,
): VisionOcrFailure {
  switch (code) {
    case "not_configured":
      return { ok: false, reason: "not_configured", detail };
    case "rate_limited":
      return { ok: false, reason: "rate_limited", detail };
    case "forbidden":
      return { ok: false, reason: "forbidden", detail };
    case "bad_request":
      return { ok: false, reason: "bad_request", detail };
    case "polling_timeout":
      return { ok: false, reason: "polling_timeout", detail };
    case "timeout":
    case "graph_unavailable":
      return { ok: false, reason: "unavailable", detail };
    default:
      return { ok: false, reason: "internal", detail };
  }
}
