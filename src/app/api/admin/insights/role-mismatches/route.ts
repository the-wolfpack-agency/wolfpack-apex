/**
 * GET /api/admin/insights/role-mismatches
 *
 * Controls that are being shown to people who cannot use them. See
 * src/lib/analytics/role-mismatch.ts for why the recording lives in
 * fetchWithRefresh, and role-mismatch-report.ts for why the ranking is by
 * repeat attempts rather than volume.
 *
 * Gated the same way as the other insights routes, on role rather than on a
 * capability, because this sits beside them on the same page and a second
 * gating style on one panel is how a page comes to have two answers to who may
 * read it.
 */
import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getRoleMismatches } from "@/lib/analytics/role-mismatch-report";

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (user.role !== "ceo" && user.role !== "cto" && user.role !== "evp") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const raw = Number(req.nextUrl.searchParams.get("days"));
  const days = Number.isFinite(raw) && raw > 0 ? clamp(Math.floor(raw), 1, 365) : 30;

  const report = await getRoleMismatches(days, 25);
  return NextResponse.json(report, {
    status: 200,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
