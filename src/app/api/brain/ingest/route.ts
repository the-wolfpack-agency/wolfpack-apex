/**
 * POST /api/brain/ingest — upload a file into the Central Brain.
 *
 * Accepts multipart/form-data with:
 *   file   — the File blob (required)
 *   tags   — optional JSON array of strings
 *
 * Returns 201 with { document_id, status, chunk_count, extracted_chars,
 * duplicate_of? } on a successful ingest (or dedupe hit).
 *
 * Audit path: delegated to lib/brain/repo.ts + lib/brain/ingest.ts where
 * trackEvent fires `brain.*` events for every state change. The route
 * itself stays in AUDIT_ALLOWLIST with the same pattern as /api/files/
 * routes (audit happens in the lib, not the thin adapter).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { ingest, BrainIngestError } from "@/lib/brain/ingest";
import { classifyKind } from "@/lib/brain/types";
import {
  rateLimitIngest,
  sanitizeFilename,
  validateMagicBytes,
} from "@/lib/brain/security";

const MAX_INLINE_BYTES = Number(process.env.BRAIN_INLINE_MAX_BYTES ?? 25 * 1024 * 1024); // 25 MB

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "brain.ingest");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  // Rate limit BEFORE reading the body — avoids buffering 25 MB from an
  // already-throttled caller.
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
  if (file.size === 0) {
    return NextResponse.json({ error: "empty file" }, { status: 400 });
  }
  if (file.size > MAX_INLINE_BYTES) {
    return NextResponse.json(
      {
        error: "file too large for inline ingest — use a worker-backed queue",
        max_bytes: MAX_INLINE_BYTES,
      },
      { status: 413 },
    );
  }

  const rawTags = form.get("tags");
  let tags: string[] = [];
  if (typeof rawTags === "string" && rawTags.trim()) {
    try {
      const parsed = JSON.parse(rawTags);
      if (Array.isArray(parsed)) {
        tags = parsed.filter((t) => typeof t === "string").slice(0, 16);
      }
    } catch {
      // ignore malformed tags — not fatal
    }
  }

  const nameCheck = sanitizeFilename(file.name || "upload");
  if (!nameCheck.ok || !nameCheck.value) {
    return NextResponse.json(
      { error: "invalid_filename", message: nameCheck.reason },
      { status: 400 },
    );
  }
  const filename = nameCheck.value;

  const buffer = Buffer.from(await file.arrayBuffer());

  // Magic-byte cross-check. For kinds we have a signature for (pdf/docx),
  // this catches Content-Type / extension spoofing before the extractor
  // runs. For other kinds it's a no-op.
  const kindGuess = classifyKind(file.type || "application/octet-stream", filename);
  const magic = validateMagicBytes(kindGuess, buffer);
  if (!magic.ok) {
    return NextResponse.json(
      {
        error: "content_type_mismatch",
        message: magic.reason,
        detected_prefix: magic.detected ?? null,
      },
      { status: 415 },
    );
  }

  try {
    const result = await ingest({
      filename,
      contentType: file.type || "application/octet-stream",
      buffer,
      uploadedBy: user.id,
      uploaderRole: user.role,
      tags,
    });
    return NextResponse.json(result, {
      status: 201,
      headers: rl.remaining !== undefined ? { "X-RateLimit-Remaining": String(rl.remaining) } : undefined,
    });
  } catch (err) {
    if (err instanceof BrainIngestError) {
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status: err.toHttpStatus() },
      );
    }
    // Never surface the raw error to the caller — could leak file paths,
    // SQL details, etc. The lib's analytics hooks already captured the
    // detail for the learning loop.
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
