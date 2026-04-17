/**
 * GET /api/brain/documents — list Brain documents with filters.
 *
 * Query params:
 *   uploaded_by — user.id filter (defaults to "all"; requires brain.manage
 *                  to see other users' uploads)
 *   kind        — pdf | docx | text | markdown | csv | html | audio | video | image | email | other
 *   status      — queued | extracting | chunking | embedding | indexed | failed | skipped
 *   tag         — filters by one tag
 *   limit       — default 50, max 500
 *   offset      — for pagination
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { listDocuments } from "@/lib/brain/repo";
import type { BrainKind, BrainStatus } from "@/lib/brain/types";

const KINDS: BrainKind[] = ["pdf", "docx", "text", "markdown", "csv", "html", "audio", "video", "image", "email", "other"];
const STATUSES: BrainStatus[] = ["queued", "extracting", "chunking", "embedding", "indexed", "failed", "skipped"];

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "brain.read");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  const { searchParams } = new URL(req.url);
  const rawUploadedBy = searchParams.get("uploaded_by") || "";
  const kind = searchParams.get("kind") as BrainKind | null;
  const status = searchParams.get("status") as BrainStatus | null;
  const tag = searchParams.get("tag") || undefined;
  const limit = Number(searchParams.get("limit") || 50);
  const offset = Number(searchParams.get("offset") || 0);

  // Privacy: default to the caller's own uploads. Seeing others requires
  // the manage capability — mirrors how /api/files works.
  let uploadedBy: string | undefined;
  if (rawUploadedBy === "all") {
    const canManage = await requireCapability(req, "brain.manage");
    if (!canManage.ok) uploadedBy = user.id; // silently scope to self
  } else if (rawUploadedBy) {
    uploadedBy = rawUploadedBy;
  } else {
    uploadedBy = user.id;
  }

  if (kind && !KINDS.includes(kind)) {
    return NextResponse.json({ error: "invalid kind" }, { status: 400 });
  }
  if (status && !STATUSES.includes(status)) {
    return NextResponse.json({ error: "invalid status" }, { status: 400 });
  }

  const docs = await listDocuments({
    uploadedBy,
    kind: kind ?? undefined,
    status: status ?? undefined,
    tag,
    limit,
    offset,
  });

  return NextResponse.json({
    documents: docs,
    count: docs.length,
    filters: { uploaded_by: uploadedBy ?? "all", kind, status, tag, limit, offset },
  });
}
