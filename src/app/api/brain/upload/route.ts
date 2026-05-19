/**
 * POST /api/brain/upload — user-driven Brain ingest.
 *
 * The "deliberate upload" surface backing the UploadToBrainWidget. Runs
 * the data-quality filter (`runUploadFilter`) BEFORE delegating to the
 * existing `ingest()` pipeline so bad content never becomes a chunk.
 *
 * Contract with the legacy /api/brain/ingest route:
 *   - SAME ingest pipeline + audit + dedup downstream.
 *   - SAME rate limiter (rateLimitIngest) so the two surfaces share a
 *     budget per user.
 *   - SAME capability gate (`brain.ingest`).
 *
 * What's different here:
 *   - The pre-filter rejects bad content (secrets, PII, empty,
 *     duplicate, repetitive, oversized, disallowed MIME) with HTTP 400
 *     + a `reasons` array the widget renders as chips.
 *   - Filter outcomes are tracked as typed analytics events:
 *       brain.upload_attempted (always, BEFORE filter)
 *       brain.upload_accepted  (filter passed + ingest succeeded)
 *       brain.upload_rejected  (filter blocked; reasons[] in metadata)
 *     — so the learning loop can see which gates fire most.
 *
 * No data lost: every attempt (even rejections) lands in the analytics
 * stream + audit trail via trackEvent. Filter rejections never write to
 * brain_documents (the legacy route's audit row is conditional on a
 * successful insert; we mirror that here — the analytics event IS the
 * audit substrate for rejections).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { ingest, BrainIngestError } from "@/lib/brain/ingest";
import { extract, isSyncExtractable } from "@/lib/brain/extractor";
import { classifyKind } from "@/lib/brain/types";
import {
  rateLimitIngest,
  sanitizeFilename,
  validateMagicBytes,
} from "@/lib/brain/security";
import {
  runUploadFilter,
  resolveMimeType,
  UPLOAD_FILTER_ALLOWED_MIME_TYPES,
  UPLOAD_FILTER_MAX_FILE_SIZE_BYTES,
} from "@/lib/brain/upload-filter";

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "brain.ingest");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  // Rate limit (shared bucket with /api/brain/ingest — same per-user
  // upload budget regardless of which entrypoint the client used).
  const rl = rateLimitIngest(user.id);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "rate_limited", retry_after_sec: rl.retryAfterSec },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "invalid multipart body" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  // Filename sanitization (matches legacy route).
  const nameCheck = sanitizeFilename(file.name || "upload");
  if (!nameCheck.ok || !nameCheck.value) {
    return NextResponse.json(
      { error: "invalid_filename", message: nameCheck.reason },
      { status: 400 },
    );
  }
  const filename = nameCheck.value;
  const declaredMime = file.type || "application/octet-stream";
  const mimeType = resolveMimeType(filename, declaredMime);

  // Hard size cap (matches the user-facing widget label so the UI can
  // pre-validate; if a client bypasses the UI we still reject server-
  // side). The pre-filter checks this again on the buffer — we short-
  // circuit here before reading the bytes to avoid buffering a 25 MB
  // payload from a deliberate offender.
  if (file.size > UPLOAD_FILTER_MAX_FILE_SIZE_BYTES) {
    return NextResponse.json(
      {
        error: "file_too_large",
        reasons: ["file_too_large"],
        max_bytes: UPLOAD_FILTER_MAX_FILE_SIZE_BYTES,
      },
      { status: 413 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json(
      { error: "empty_file", reasons: ["empty_file"] },
      { status: 400 },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // Audit BEFORE filter — every POST is observable in analytics even
  // when the gate blocks it. content_hash is computed by the filter so
  // we hash the raw bytes here (rough proxy — the filter's hash is on
  // normalized text and may differ; both are recorded downstream).
  const rawHashPreview = bufferShortHash(buffer);
  await trackEvent("brain.upload_attempted", user.id, user.role, {
    content_hash: rawHashPreview,
    file_size: buffer.length,
    mime_type: mimeType,
    filename,
  });

  // Magic-byte cross-check (PDF / DOCX). Cheap to run before the
  // extractor + filter; catches Content-Type spoofing.
  const kindGuess = classifyKind(mimeType, filename);
  const magic = validateMagicBytes(kindGuess, buffer);
  if (!magic.ok) {
    await trackEvent("brain.upload_rejected", user.id, user.role, {
      reasons: "content_type_mismatch",
      reason_count: 1,
      content_hash: rawHashPreview,
      mime_type: mimeType,
    });
    return NextResponse.json(
      {
        error: "content_type_mismatch",
        reasons: ["content_type_mismatch"],
        message: magic.reason,
      },
      { status: 415 },
    );
  }

  // Extract plaintext so the filter can run content gates. Audio /
  // video / image are excluded by the MIME allowlist; this branch is
  // here for safety, not because we expect to hit it.
  let extractedText: string | undefined;
  if (isSyncExtractable(kindGuess)) {
    const ex = await extract(kindGuess, buffer);
    if (ex.ok) extractedText = ex.text;
  }

  // The data-quality gate.
  const filter = await runUploadFilter({
    filename,
    mimeType,
    buffer,
    extractedText,
  });

  if (!filter.ok) {
    await trackEvent("brain.upload_rejected", user.id, user.role, {
      /* Stored as a comma-joined string because the analytics metadata
       * column accepts only scalar values. The reason_count column +
       * the literal joined list together let dashboards group by
       * canonical reasons and rank gate triggers. */
      reasons: filter.reasons.join(","),
      reason_count: filter.reasons.length,
      content_hash: filter.contentHash ?? rawHashPreview,
      mime_type: mimeType,
    });
    return NextResponse.json(
      {
        error: "upload_rejected",
        reasons: filter.reasons,
        content_hash: filter.contentHash ?? null,
      },
      { status: 400 },
    );
  }

  // Filter passed — hand off to the existing ingest pipeline. ingest()
  // owns its own audit / dedup / chunk / embed / index lifecycle.
  try {
    const result = await ingest({
      filename,
      contentType: mimeType,
      buffer,
      uploadedBy: user.id,
      uploaderRole: user.role,
      tags: ["upload-to-brain-widget"],
    });
    await trackEvent("brain.upload_accepted", user.id, user.role, {
      content_hash: filter.contentHash,
      document_id: result.document_id,
      duplicate_of: result.duplicate_of ?? "",
      mime_type: mimeType,
      warnings: filter.warnings.join(","),
      warning_count: filter.warnings.length,
    });
    return NextResponse.json(
      {
        ...result,
        warnings: filter.warnings,
      },
      {
        status: 201,
        headers:
          rl.remaining !== undefined
            ? { "X-RateLimit-Remaining": String(rl.remaining) }
            : undefined,
      },
    );
  } catch (err) {
    if (err instanceof BrainIngestError) {
      await trackEvent("brain.upload_rejected", user.id, user.role, {
        reasons: err.code,
        reason_count: 1,
        content_hash: filter.contentHash,
        mime_type: mimeType,
      });
      return NextResponse.json(
        { error: err.code, reasons: [err.code], message: err.message },
        { status: err.toHttpStatus() },
      );
    }
    await trackEvent("brain.upload_rejected", user.id, user.role, {
      reasons: "internal",
      reason_count: 1,
      content_hash: filter.contentHash,
      mime_type: mimeType,
    });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}

/** Stable short hash for audit metadata BEFORE the filter has computed
 *  the canonical normalized hash. Truncated to 16 chars for readability
 *  in analytics dashboards. */
function bufferShortHash(buf: Buffer): string {
  // Local hash; avoids importing crypto in two places.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto");
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

// Re-export config for the widget tool to seed its UploadToBrainWidget
// spec without duplicating constants.
export const UPLOAD_ROUTE_CONFIG = {
  uploadUrl: "/api/brain/upload",
  maxFileSize: UPLOAD_FILTER_MAX_FILE_SIZE_BYTES,
  allowedMimeTypes: UPLOAD_FILTER_ALLOWED_MIME_TYPES,
} as const;
