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

const MAX_INLINE_BYTES = Number(process.env.BRAIN_INLINE_MAX_BYTES ?? 25 * 1024 * 1024); // 25 MB

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "brain.ingest");
  if (!auth.ok) return auth.response;
  const user = auth.user;

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

  const filename = file.name || "upload";
  if (filename.includes("/") || filename.includes("\\")) {
    return NextResponse.json({ error: "invalid filename" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const result = await ingest({
      filename,
      contentType: file.type || "application/octet-stream",
      buffer,
      uploadedBy: user.id,
      uploaderRole: user.role,
      tags,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof BrainIngestError) {
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status: err.toHttpStatus() },
      );
    }
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
