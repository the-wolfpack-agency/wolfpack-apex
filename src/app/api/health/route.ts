import { NextResponse } from "next/server";
import { query } from "@/lib/db";

/**
 * Liveness, and an optional readiness probe. Plain GET is liveness (200 if the
 * process is up). GET ?deep=1 is READINESS: it fast-probes the database (3s, no
 * retry) and returns 503 db:"down" when it is unreachable, so an uptime monitor
 * (Dynatrace or similar) detects a dependency outage instead of only seeing the
 * app alive. Kept separate so a DB blip does not mark the whole app dead.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const deep = new URL(req.url).searchParams.get("deep") === "1";
  if (!deep) return NextResponse.json({ ok: true });
  let db: "up" | "down" = "up";
  try {
    await Promise.race([
      query("SELECT 1"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("probe timeout")), 3_000)),
    ]);
  } catch {
    db = "down";
  }
  return NextResponse.json({ ok: db === "up", db }, { status: db === "up" ? 200 : 503 });
}
