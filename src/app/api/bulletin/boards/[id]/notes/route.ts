/**
 * POST /api/bulletin/boards/[id]/notes — create a sticky note on a board.
 *
 * Rejects writes against archived boards (the lib enforces this; we
 * map the thrown error to a 409 so callers can render "this board is
 * frozen, create a copy" UX).
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { createNote } from "@/lib/bulletin/notes";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: boardId } = await context.params;

  let body: {
    body?: string;
    color?: string;
    position?: {
      x_pct?: number;
      y_pct?: number;
      width_pct?: number;
      height_pct?: number;
      rotation_deg?: number;
    };
    association?: { kind?: string; id?: string; label?: string | null };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body?.body || typeof body.body !== "string") {
    return NextResponse.json({ error: "body is required" }, { status: 400 });
  }

  /* Coerce a partial association into the lib's expected shape; let
     the lib do final validation (kind enum, id non-empty). */
  let assocArg:
    | { kind: string; id: string; label?: string | null }
    | undefined;
  if (body.association) {
    if (typeof body.association.kind !== "string") {
      return NextResponse.json(
        { error: "association.kind is required" },
        { status: 400 },
      );
    }
    if (typeof body.association.id !== "string" || !body.association.id) {
      return NextResponse.json(
        { error: "association.id is required" },
        { status: 400 },
      );
    }
    assocArg = {
      kind: body.association.kind,
      id: body.association.id,
      label: body.association.label ?? null,
    };
  }

  try {
    const note = await createNote({
      boardId,
      body: body.body,
      color: body.color,
      position: body.position,
      association: assocArg,
      userId: user.id,
      userRole: user.role,
      userName: user.name,
    });

    trackEvent("bulletin.note_created", user.id, user.role, {
      board_id: boardId,
      has_association: Boolean(note.associationKind),
      kind: note.associationKind ?? "none",
    });

    return NextResponse.json({ note });
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (/board not found/.test(msg)) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    if (/archived/.test(msg)) {
      return NextResponse.json({ error: msg }, { status: 409 });
    }
    if (/association|body|required/.test(msg)) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    console.error(
      "[api/bulletin/boards/id/notes] create failed:",
      msg,
    );
    return NextResponse.json({ error: "Failed to create note" }, { status: 500 });
  }
}
