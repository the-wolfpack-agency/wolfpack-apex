/**
 * GET   /api/documents/recognize/[id] — fetch a recognition by id.
 * PATCH /api/documents/recognize/[id] — record a user correction
 *       (user reclassified the document type). Drives the learning loop.
 *
 * Both routes are workspace-scoped: a recognition in another workspace
 * is structurally invisible — the persistence layer joins on
 * (workspace_id, id) so an attacker cannot enumerate ids cross-tenant.
 *
 * Capability: tools.run (same as POST). The correction signal is the
 * primary training input — locking it behind a separate cap would just
 * starve the learning loop.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import {
  getRecognition,
  recordUserCorrection,
} from "@/lib/document-recognition/persistence";
import {
  DOCUMENT_TYPES,
  type DocumentType,
} from "@/lib/document-recognition/types";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "tools.run");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const recognition = await getRecognition(auth.user.workspaceId, id);
  if (!recognition) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, recognition });
}

interface PatchBody {
  user_corrected_type?: unknown;
}

function isDocumentType(v: unknown): v is DocumentType {
  return typeof v === "string" && (DOCUMENT_TYPES as readonly string[]).includes(v);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "tools.run");
  if (!auth.ok) return auth.response;

  const { id } = await params;

  let body: PatchBody | null;
  try {
    body = (await req.json()) as PatchBody | null;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body || !isDocumentType(body.user_corrected_type)) {
    return NextResponse.json(
      { error: "invalid_corrected_type", allowed: DOCUMENT_TYPES },
      { status: 400 },
    );
  }

  /* Read the prior row so the analytics event records the original
     classified_type the user was overriding — needed by the learning
     loop to compute classifier accuracy by type. */
  const prior = await getRecognition(auth.user.workspaceId, id);
  if (!prior) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const updated = await recordUserCorrection({
    workspaceId: auth.user.workspaceId,
    id,
    correctedType: body.user_corrected_type,
  });
  if (!updated) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  trackEvent(
    "system.document_recognition_corrected",
    auth.user.id,
    auth.user.role,
    {
      recognition_id: id,
      original_type: prior.classification.type,
      corrected_type: body.user_corrected_type,
    },
  );

  return NextResponse.json({ ok: true, recognition: updated });
}
