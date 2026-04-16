/**
 * POST /api/files/[id]/share — create a share link.
 *
 * Body: { type: "view" | "edit"; scope: "anonymous" | "organization" }
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { createShareLink, GraphFilesError } from "@/lib/integrations/microsoft-files";

const VALID_TYPES = ["view", "edit"] as const;
const VALID_SCOPES = ["anonymous", "organization"] as const;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  let body: { type?: string; scope?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  if (!body.type || !(VALID_TYPES as readonly string[]).includes(body.type)) {
    return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  }
  if (!body.scope || !(VALID_SCOPES as readonly string[]).includes(body.scope)) {
    return NextResponse.json({ error: "Invalid scope" }, { status: 400 });
  }

  try {
    const share = await createShareLink(
      user.id,
      id,
      { type: body.type as "view" | "edit", scope: body.scope as "anonymous" | "organization" },
      { user_id: user.id, role: user.role },
    );
    return NextResponse.json({ share }, { status: 201 });
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
