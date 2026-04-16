/**
 * POST /api/files/upload-session — start a resumable upload session.
 *
 * Body: { parentId: string; filename: string }
 * Returns: { uploadUrl, expirationDateTime }
 *
 * The browser PUTs the actual bytes directly to Graph in chunks using
 * the returned uploadUrl. Instinct does not proxy bytes.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { startUploadSession, GraphFilesError } from "@/lib/integrations/microsoft-files";

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { parentId?: string; filename?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const parentId = body.parentId || "root";
  if (!body.filename || typeof body.filename !== "string") {
    return NextResponse.json({ error: "filename is required" }, { status: 400 });
  }
  if (body.filename.includes("/") || body.filename.includes("\\")) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }

  try {
    const session = await startUploadSession(user.id, parentId, body.filename);
    return NextResponse.json(session, { status: 201 });
  } catch (err) {
    if (err instanceof GraphFilesError) {
      if (err.status === 401) return NextResponse.json({ error: "Microsoft not connected" }, { status: 401 });
      if (err.status === 403) return NextResponse.json({ error: "scope_missing", scope: "Files.ReadWrite" }, { status: 403 });
      return NextResponse.json({ error: err.message }, { status: err.status >= 500 ? 502 : err.status });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
