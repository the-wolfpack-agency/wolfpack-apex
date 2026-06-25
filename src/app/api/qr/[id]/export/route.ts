/**
 * /api/qr/[id]/export - export beacon.
 *
 * The download menu fires this fire-and-forget when a member saves a QR in any
 * format (svg/png/jpg/pdf/eps). It performs NO mutation - it only records
 * `assistant.qr_code_exported` so the learning loop sees which print/share
 * formats the team actually uses (e.g. EPS demand from print houses). Without it
 * the export signal was silently lost.
 *
 * Auth-gated like the other QR detail routes: unauthenticated callers get 401.
 */
import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";

const FORMATS = new Set(["svg", "png", "jpg", "pdf", "eps"]);

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: "code id required" }, { status: 400 });

  let body: { format?: unknown } = {};
  try { body = await req.json(); } catch { body = {}; }
  const format = typeof body.format === "string" && FORMATS.has(body.format) ? body.format : "unknown";

  trackEvent("assistant.qr_code_exported", user.id, user.role, { code_id: id, format });
  return NextResponse.json({ ok: true });
}
