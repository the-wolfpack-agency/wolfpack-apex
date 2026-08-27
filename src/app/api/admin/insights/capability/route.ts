/**
 * GET /api/admin/insights/capability
 *
 * The Phase 1 shop window: what this product can demonstrably do, read from
 * what it has actually done over the last N days.
 *
 * Computed per request rather than cached. A capability page that shows a
 * figure which was true at deploy time is the failure this whole surface
 * exists to avoid.
 *
 * Gated on role like its siblings under admin/insights.
 */
import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { readCapabilitySnapshot } from "@/lib/insights/capability-snapshot";

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "ceo" && user.role !== "cto" && user.role !== "evp") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const raw = Number(req.nextUrl.searchParams.get("days"));
  const days = Number.isFinite(raw) && raw > 0 ? clamp(Math.floor(raw), 1, 365) : 90;

  try {
    const snapshot = await readCapabilitySnapshot(days);
    return NextResponse.json(
      { readable: true, snapshot },
      { status: 200, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (err) {
    /* Unreadable is not the same fact as "this product does nothing". */
    return NextResponse.json(
      { readable: false, error: (err as Error).message },
      { status: 200, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}
