/**
 * GET /api/files/[id]/download-url — return a short-lived Graph download
 * URL. The browser can fetch the bytes directly; Instinct does not proxy.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getDownloadUrl, GraphFilesError } from "@/lib/integrations/microsoft-files";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  try {
    const url = await getDownloadUrl(user.id, id);
    if (!url) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ url });
  } catch (err) {
    if (err instanceof GraphFilesError) {
      if (err.status === 401) return NextResponse.json({ error: "Microsoft not connected" }, { status: 401 });
      if (err.status === 403) return NextResponse.json({ error: "scope_missing", scope: "Files.ReadWrite" }, { status: 403 });
      return NextResponse.json({ error: err.message }, { status: err.status >= 500 ? 502 : err.status });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
