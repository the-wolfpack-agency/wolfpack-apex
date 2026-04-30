/**
 * GET /api/bulletin/by-association?kind=meeting&id=...
 *
 * Cross-surface lookup: returns every active note + every snapshot
 * tied to the given (kind, id) pair so e.g. a meeting detail page can
 * render its bulletin attachments inline.
 *
 * `kind` is validated against the lib's allow-list; an unknown kind
 * returns `{ notes: [], snapshots: [] }` (rather than 400) so callers
 * can render an empty state without branching on the wire format.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { findNotesByAssociation } from "@/lib/bulletin/notes";
import { findSnapshotsByAssociation } from "@/lib/bulletin/snapshots";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") ?? "";
  const id = url.searchParams.get("id") ?? "";

  if (!kind || !id) {
    return NextResponse.json(
      { error: "kind and id are required" },
      { status: 400 },
    );
  }

  const [notes, snapshots] = await Promise.all([
    findNotesByAssociation(kind, id),
    findSnapshotsByAssociation(kind, id),
  ]);

  return NextResponse.json({ notes, snapshots });
}
