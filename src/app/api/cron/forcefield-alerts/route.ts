import { NextResponse } from "next/server";
import { isAuthorizedBearer } from "@/lib/auth/bearer-auth";
import {
  scanForcefieldWebAlerts,
  runDailyDigest,
  runAlertSilenceCheck,
  isSilenceCheckHour,
  liveForcefieldAlertDeps,
} from "@/lib/forcefield-web/alerts";

/**
 * Forcefield-web hostile-signal alerts (Vercel cron, every 10 minutes, see
 * vercel.json). Each run:
 *   1. the incident scan: an IMMEDIATE email only for incidents that need
 *      attention (decoy / honeytoken trips, requests not blocked), one per
 *      incident (site + source burst + 6-hour window);
 *   2. the DAILY DIGEST of blocked incidents: real work only on the first run
 *      at or after 08:00 US Eastern (claimed once per Eastern date, so it
 *      cannot double-send; a failed send is retried on later runs);
 *   3. during the 15:00 UTC hour, the SILENCE CHECK (or on demand with
 *      ?job=silence): an alert when attention-worthy traffic got no immediate
 *      alert, or blocked traffic got no digest. Deduped once per UTC day.
 * ?job=digest runs only the digest step (same once-per-day claim).
 *
 * Optional CRON_SECRET. Never throws; a DB blip reports 200 so the schedule
 * keeps running, with ok:false so the failure is visible in the cron log.
 */
export const dynamic = "force-dynamic";

const JOBS = new Set(["silence", "digest"]);

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (!isAuthorizedBearer(auth, secret)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const job = new URL(req.url).searchParams.get("job");
  if (job !== null && !JOBS.has(job)) {
    return NextResponse.json({ ok: false, error: "job must be 'silence', 'digest' or omitted" }, { status: 400 });
  }
  const now = new Date();
  const deps = liveForcefieldAlertDeps();
  let scan: Awaited<ReturnType<typeof scanForcefieldWebAlerts>> | null = null;
  let scanError: string | null = null;
  if (job === null) {
    try {
      scan = await scanForcefieldWebAlerts(deps, now);
    } catch (err) {
      scanError = ((err as Error)?.message ?? "unknown").slice(0, 200);
    }
  }
  // The digest and the silence check run even when the scan failed: they are
  // separate paths, and the silence check exists to catch a broken scan.
  try {
    const digest = job === null || job === "digest" ? await runDailyDigest(deps, now) : null;
    const silence = job === "silence" || (job === null && isSilenceCheckHour(now)) ? await runAlertSilenceCheck(deps, now) : null;
    const body = {
      detected: scan?.detected ?? 0,
      immediate: scan?.immediate ?? 0,
      digestOnly: scan?.digestOnly ?? 0,
      dispatched: scan?.dispatched ?? 0,
      delivered: scan?.delivered ?? 0,
      failed: scan?.failed ?? 0,
      digest: digest ? { due: digest.due, claimed: digest.claimed, outcome: digest.outcome, incidents: digest.incidents, attempts: digest.attempts, etDate: digest.etDate ?? null } : { due: false },
      silence: silence ? { checked: true, silent: silence.silent, reasons: silence.reasons, hostileEvents: silence.hostileEvents, deliveredAlerts: silence.deliveredAlerts, alert: silence.alert?.status ?? null } : { checked: false },
    };
    if (scanError) return NextResponse.json({ ok: false, error: "scan_failed", detail: scanError, ...body });
    return NextResponse.json({ ok: true, ...body });
  } catch (err) {
    return NextResponse.json({ ok: false, error: scanError ? "scan_failed" : "digest_or_silence_failed", detail: (scanError ?? (err as Error)?.message ?? "unknown").slice(0, 200), detected: scan?.detected ?? 0, dispatched: scan?.dispatched ?? 0 });
  }
}
