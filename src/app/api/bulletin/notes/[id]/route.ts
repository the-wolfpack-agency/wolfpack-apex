/**
 * /api/bulletin/notes/[id] — PATCH / DELETE a single sticky note.
 *
 * PATCH accepts a partial body, color, position fields, and optional
 * association update (or null to clear). DELETE is a soft-delete via
 * `deleted_at`.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { deleteNote, updateNote } from "@/lib/bulletin/notes";

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;

  let body: {
    body?: string;
    color?: string;
    x_pct?: number;
    y_pct?: number;
    width_pct?: number;
    height_pct?: number;
    rotation_deg?: number;
    association?: { kind?: string; id?: string; label?: string | null } | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const patch: Parameters<typeof updateNote>[1] = {};
  if (body.body !== undefined) patch.body = body.body;
  if (body.color !== undefined) patch.color = body.color;
  for (const f of ["x_pct", "y_pct", "width_pct", "height_pct", "rotation_deg"] as const) {
    const v = body[f];
    if (v !== undefined) patch[f] = v;
  }
  if (body.association !== undefined) {
    if (body.association === null) {
      patch.association = null;
    } else {
      if (
        typeof body.association.kind !== "string" ||
        typeof body.association.id !== "string" ||
        !body.association.id
      ) {
        return NextResponse.json(
          { error: "association.kind and association.id are required" },
          { status: 400 },
        );
      }
      patch.association = {
        kind: body.association.kind,
        id: body.association.id,
        label: body.association.label ?? null,
      };
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "patch is empty" }, { status: 400 });
  }

  try {
    const note = await updateNote(id, patch);
    if (!note) return NextResponse.json({ error: "not found" }, { status: 404 });

    trackEvent("bulletin.note_updated", user.id, user.role, {
      note_id: note.id,
      board_id: note.boardId,
    });

    return NextResponse.json({ note });
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (/association|finite number|non-empty|required/.test(msg)) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    console.error("[api/bulletin/notes/id] update failed:", msg);
    return NextResponse.json({ error: "Failed to update note" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;

  try {
    await deleteNote(id);
    trackEvent("bulletin.note_deleted", user.id, user.role, {
      note_id: id,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(
      "[api/bulletin/notes/id] delete failed:",
      (err as Error).message,
    );
    return NextResponse.json({ error: "Failed to delete note" }, { status: 500 });
  }
}
