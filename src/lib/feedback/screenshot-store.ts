/**
 * screenshot-store: persist and read the optional image attached to a
 * feedback submission (migration 168, table instinct_feedback_screenshot).
 *
 * The client compresses the image before upload, so by the time it reaches
 * here it should already be small. We still validate type and size on the
 * server because a client check is never a trust boundary.
 *
 * Security notes:
 *   - Only raster types are accepted. SVG is rejected on purpose: an inline
 *     SVG can carry script, and we never want a stored bug screenshot to be
 *     an XSS vector when a reader opens it.
 *   - The read endpoint that serves these is capability gated and workspace
 *     scoped (see the admin screenshot route); this module only stores and
 *     returns bytes, it does not make authorization decisions.
 */

import { query, writeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

/** Raster image types we accept. JPEG is the client compressor's output;
 *  PNG / WebP / GIF cover the rest of a normal screenshot path. */
export const ALLOWED_SCREENSHOT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/**
 * Server-side ceiling on the decoded image. The client targets ~480 KB
 * after compression; we allow some headroom so a legitimately-compressed
 * screenshot is never rejected at the door, while still capping the row
 * size. base64 inflates by ~33%, so the stored TEXT stays well under 1 MB.
 */
export const MAX_SCREENSHOT_BYTES = 700_000;

export interface ScreenshotInput {
  contentType: string;
  /** Base64 of the image bytes, with or without a leading data URL prefix. */
  dataBase64: string;
  /** Client-reported decoded byte size. Re-derived server-side, never trusted. */
  byteSize?: number;
}

export interface StoredScreenshot {
  contentType: string;
  dataBase64: string;
  byteSize: number;
}

export type ScreenshotValidation =
  | { ok: true; contentType: string; dataBase64: string; byteSize: number }
  | { ok: false; reason: string };

/** Strip an optional "data:<type>;base64," prefix and return raw base64. */
export function stripDataUrlPrefix(s: string): string {
  const comma = s.indexOf(",");
  if (s.startsWith("data:") && comma !== -1) return s.slice(comma + 1);
  return s;
}

/** Decoded byte length of a base64 string, without allocating the buffer. */
export function base64ByteLength(b64: string): number {
  const clean = b64.replace(/\s/g, "");
  if (clean.length === 0) return 0;
  let padding = 0;
  if (clean.endsWith("==")) padding = 2;
  else if (clean.endsWith("=")) padding = 1;
  return Math.floor((clean.length * 3) / 4) - padding;
}

/**
 * Validate an incoming screenshot. Pure and unit-testable: no DB, no IO.
 * Returns the cleaned base64 (prefix stripped) and the true decoded size.
 */
export function validateScreenshot(input: unknown): ScreenshotValidation {
  if (!input || typeof input !== "object") {
    return { ok: false, reason: "missing" };
  }
  const obj = input as Record<string, unknown>;
  const contentType =
    typeof obj.content_type === "string" ? obj.content_type.trim() : "";
  const rawData =
    typeof obj.data_base64 === "string" ? obj.data_base64 : "";

  if (!ALLOWED_SCREENSHOT_TYPES.has(contentType)) {
    return { ok: false, reason: "unsupported_type" };
  }
  const dataBase64 = stripDataUrlPrefix(rawData).replace(/\s/g, "");
  if (!dataBase64) {
    return { ok: false, reason: "empty" };
  }
  // Reject anything that is not valid base64 so we never store garbage that
  // the read endpoint would then fail to decode.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) {
    return { ok: false, reason: "not_base64" };
  }
  const byteSize = base64ByteLength(dataBase64);
  if (byteSize <= 0) {
    return { ok: false, reason: "empty" };
  }
  if (byteSize > MAX_SCREENSHOT_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  return { ok: true, contentType, dataBase64, byteSize };
}

/**
 * Persist a validated screenshot for a feedback row. One screenshot per
 * feedback (the PK is feedback_id); a repeat upsert replaces it.
 *
 * Returns the stored byte size on success. Throws WriteQueryError on a real
 * DB failure so the caller can decide what to surface; the caller treats a
 * screenshot failure as non-fatal (the feedback text is already saved).
 */
export async function storeFeedbackScreenshot(
  feedbackId: string,
  input: ScreenshotInput,
  ctx?: { userId?: string; userRole?: string },
): Promise<{ byteSize: number }> {
  const validation = validateScreenshot({
    content_type: input.contentType,
    data_base64: input.dataBase64,
  });
  if (!validation.ok) {
    throw new Error(`invalid_screenshot:${validation.reason}`);
  }

  await writeQuery(
    `INSERT INTO instinct_feedback_screenshot
        (feedback_id, content_type, data_base64, byte_size)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (feedback_id) DO UPDATE SET
        content_type = EXCLUDED.content_type,
        data_base64 = EXCLUDED.data_base64,
        byte_size = EXCLUDED.byte_size,
        created_at = NOW()`,
    [feedbackId, validation.contentType, validation.dataBase64, validation.byteSize],
    { expectRows: 0 },
  );

  trackEvent(
    "assistant.feedback_screenshot_stored",
    ctx?.userId ?? "system",
    ctx?.userRole ?? "unknown",
    {
      feedback_id: feedbackId,
      byte_size: validation.byteSize,
      content_type: validation.contentType,
    },
  );

  return { byteSize: validation.byteSize };
}

/** Fetch the stored screenshot for a feedback row, or null if none. */
export async function getFeedbackScreenshot(
  feedbackId: string,
): Promise<StoredScreenshot | null> {
  const { rows } = await query<{
    content_type: string;
    data_base64: string;
    byte_size: number;
  }>(
    `SELECT content_type, data_base64, byte_size
       FROM instinct_feedback_screenshot
      WHERE feedback_id = $1`,
    [feedbackId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    contentType: row.content_type,
    dataBase64: row.data_base64,
    byteSize: Number(row.byte_size),
  };
}
