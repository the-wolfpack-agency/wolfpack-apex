/**
 * /api/email-signatures/[id] — single-signature PATCH / DELETE.
 *
 * PATCH body: any subset of { label, body, isDefault }. Promoting to
 * default demotes the prior default atomically.
 *
 * DELETE removes the signature outright. There is no soft-archive
 * because signatures are personal and small; no audit value in keeping
 * deleted rows.
 *
 * All routes scope by `user.id` from the JWT. A user cannot mutate or
 * delete another user's signatures (the SQL has `WHERE user_id = $userId`).
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { updateSignature, deleteSignature } from "@/lib/email-signatures";

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  let body: { label?: unknown; body?: unknown; isDefault?: unknown };
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const patch: {
    label?: string;
    body?: string;
    isDefault?: boolean;
  } = {};
  if (typeof body.label === "string") patch.label = body.label;
  if (typeof body.body === "string") patch.body = body.body;
  if (typeof body.isDefault === "boolean") patch.isDefault = body.isDefault;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "patch is empty" }, { status: 400 });
  }

  try {
    const signature = await updateSignature(id, user.id, patch);
    return NextResponse.json({ signature });
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (
      /required|too long|patch is empty/.test(msg) ||
      msg.includes("invalid")
    ) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    if (/row-count mismatch/.test(msg)) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    console.error(
      "[api/email-signatures/id] update failed:",
      msg,
    );
    return NextResponse.json(
      { error: "Failed to update signature" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  try {
    const result = await deleteSignature(id, user.id);
    if (!result.deleted) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(
      "[api/email-signatures/id] delete failed:",
      (err as Error).message,
    );
    return NextResponse.json(
      { error: "Failed to delete signature" },
      { status: 500 },
    );
  }
}
