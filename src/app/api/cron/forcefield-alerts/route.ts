import { NextResponse } from "next/server";
import { isAuthorizedBearer } from "@/lib/auth/bearer-auth";
import {
  scanForcefieldWebAlerts,
  runAlertSilenceCheck,
  isSilenceCheckHour,
  liveForcefieldAlertDeps,
} from "@/lib/forcefield-web/alerts";

/**
 * Forcefield-web hostile-signal alert scan (Vercel cron, every 10 minutes, see
 * vercel.json). Alerts a person once per incident (site + attack class + 6-hour
 * window) and records the delivery outcome.
 *
 * Also the daily SILENCE CHECK: during the 12:00 UTC hour (or on demand with
 * ?job=silence) it raises an alert when hostile events exist in the last 24h
 * but no alert reached anyone. Deduped once per UTC day.
 *
 * Optional CRON_SECRET. Never throws; a DB blip reports 200 so the schedule
 * keeps running, with ok:false so the failure is visible in the cron log.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (!isAuthorizedBearer(auth, secret)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const job = new URL(req.url).searchParams.get("job");
  if (job !== null && job !== "silence") {
    return NextResponse.json({ ok: false, error: "job must be 'silence' or omitted" }, { status: 400 });
  }
  const now = new Date();
  const deps = liveForcefieldAlertDeps();
  try {
    const scan = job === "silence" ? null : await scanForcefieldWebAlerts(deps);
    const silence = job === "silence" || isSilenceCheckHour(now) ? await runAlertSilenceCheck(deps, now) : null;
    return NextResponse.json({
      ok: true,
      detected: scan?.detected ?? 0,
      dispatched: scan?.dispatched ?? 0,
      delivered: scan?.delivered ?? 0,
      failed: scan?.failed ?? 0,
      silence: silence ? { checked: true, silent: silence.silent, hostileEvents: silence.hostileEvents, deliveredAlerts: silence.deliveredAlerts, alert: silence.alert?.status ?? null } : { checked: false },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: "scan_failed", detail: ((err as Error)?.message ?? "unknown").slice(0, 200), detected: 0, dispatched: 0 });
  }
}
