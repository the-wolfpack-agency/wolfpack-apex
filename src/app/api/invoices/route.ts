/**
 * GET /api/invoices — the trackers the caller may view (drives the /invoices
 * index + the nav). Filtered by the same per-tracker email allowlist as the
 * item routes; returns only ids + labels, never any invoice data.
 */
import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackersForViewer } from "@/lib/invoice-tracker/config";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const trackers = trackersForViewer(user.email).map((t) => ({ id: t.id, company: t.company }));
  return NextResponse.json({ trackers });
}
