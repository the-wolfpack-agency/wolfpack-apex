import { NextResponse } from "next/server";
import { scanForcefieldWebAlerts, liveForcefieldAlertDeps } from "@/lib/forcefield-web/alerts";

/**
 * Forcefield-web hostile-signal alert scan (Vercel cron, see vercel.json).
 * Alerts the team on NEW honeytoken trips / payload attacks, deduped. Optional
 * CRON_SECRET. Never throws; a DB blip reports 200 so the schedule keeps running.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await scanForcefieldWebAlerts(liveForcefieldAlertDeps());
    return NextResponse.json({ ok: true, ...result });
  } catch {
    return NextResponse.json({ ok: true, detected: 0, dispatched: 0 });
  }
}
