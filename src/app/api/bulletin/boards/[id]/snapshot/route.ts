/**
 * POST /api/bulletin/boards/[id]/snapshot — save a frozen PNG of a board.
 *
 * Body shape: `{ png_base64, association? }`.
 *
 * The client renders the board to a canvas (e.g. html2canvas) and
 * sends the dataURL-stripped base64 string. We decode → BYTEA → DB.
 *
 * Cap is 4MB raw — anything larger returns 413. Boards are intended
 * to be small at agency scale; a 4MB PNG suggests a screenshot of an
 * entire monitor, not a sticky-note board.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { getBoard } from "@/lib/bulletin/boards";
import { saveSnapshot } from "@/lib/bulletin/snapshots";

const MAX_PNG_BYTES = 4 * 1024 * 1024;

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: boardId } = await context.params;

  let body: {
    png_base64?: string;
    association?: { kind?: string; id?: string; label?: string | null };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body?.png_base64 || typeof body.png_base64 !== "string") {
    return NextResponse.json(
      { error: "png_base64 is required" },
      { status: 400 },
    );
  }

  /* Strip a leading `data:image/png;base64,` if the client forgot to. */
  const cleaned = body.png_base64.replace(/^data:image\/png;base64,/, "");

  let buf: Buffer;
  try {
    buf = Buffer.from(cleaned, "base64");
  } catch {
    return NextResponse.json({ error: "png_base64 decode failed" }, { status: 400 });
  }
  if (buf.length === 0) {
    return NextResponse.json(
      { error: "png_base64 decoded to empty bytes" },
      { status: 400 },
    );
  }
  if (buf.length > MAX_PNG_BYTES) {
    return NextResponse.json(
      { error: `png exceeds ${MAX_PNG_BYTES} bytes` },
      { status: 413 },
    );
  }

  /* 404 the snapshot post if the board doesn't exist; the lib doesn't
     check (saveSnapshot is intentionally cheap), so we do it here. */
  const board = await getBoard(boardId);
  if (!board) return NextResponse.json({ error: "not found" }, { status: 404 });

  let assocArg:
    | { kind: string; id: string; label?: string | null }
    | undefined;
  if (body.association) {
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
    assocArg = {
      kind: body.association.kind,
      id: body.association.id,
      label: body.association.label ?? null,
    };
  }

  try {
    const snapshot = await saveSnapshot({
      boardId,
      pngBytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      association: assocArg,
      userId: user.id,
    });

    trackEvent("bulletin.snapshot_saved", user.id, user.role, {
      board_id: boardId,
      has_association: Boolean(snapshot.associationKind),
      kind: snapshot.associationKind ?? "none",
    });

    return NextResponse.json({ snapshot });
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (/association/.test(msg)) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    console.error(
      "[api/bulletin/boards/id/snapshot] save failed:",
      msg,
    );
    return NextResponse.json(
      { error: "Failed to save snapshot" },
      { status: 500 },
    );
  }
}
