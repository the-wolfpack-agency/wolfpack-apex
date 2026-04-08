/**
 * /api/people/benefits/[id] — fetch full document detail (plans + recs).
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getBenefitDocument, deleteBenefitDocument } from "@/lib/benefits";

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const result = await getBenefitDocument(id);
  if (!result.document) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Include the raw text excerpt at the top level so the UI can render
  // it for debugging when the parser produces wrong values.
  return NextResponse.json({
    ...result,
    raw_text_excerpt: (result.document as { raw_text_excerpt?: string }).raw_text_excerpt ?? "",
  });
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const ok = await deleteBenefitDocument(id, user.id, user.role);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
