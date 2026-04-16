/**
 * GET    /api/files/[id] — metadata for a single drive item.
 * DELETE /api/files/[id] — delete a drive item.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getItem, deleteItem, GraphFilesError } from "@/lib/integrations/microsoft-files";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    const item = await getItem(user.id, id);
    if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ item });
  } catch (err) {
    if (err instanceof GraphFilesError) {
      if (err.status === 401) return NextResponse.json({ error: "Microsoft not connected" }, { status: 401 });
      return NextResponse.json({ error: err.message }, { status: err.status >= 500 ? 502 : err.status });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    await deleteItem(user.id, id, { user_id: user.id, role: user.role });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof GraphFilesError) {
      if (err.status === 401) return NextResponse.json({ error: "Microsoft not connected" }, { status: 401 });
      if (err.status === 403) return NextResponse.json({ error: "scope_missing", scope: "Files.ReadWrite" }, { status: 403 });
      if (err.status === 404) return NextResponse.json({ error: "Not found" }, { status: 404 });
      return NextResponse.json({ error: err.message }, { status: err.status >= 500 ? 502 : err.status });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
