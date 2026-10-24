/**
 * GET /api/cron/ai-spend-anomaly: the daily AI spend-spike scan.
 *
 * Compares each bucket's (every workspace, plus __unattributed__) last-24h AI
 * spend with its trailing 7-day daily mean and alerts the spend owner through
 * the team notification layer when it spikes. The rule and why it exists live
 * in src/lib/ai/spend-anomaly.ts; this handler only authorizes and delegates.
 *
 * Cron-only, fail CLOSED: `Authorization: Bearer ${CRON_SECRET}`, compared in
 * constant time by isAuthorizedBearer. An unset CRON_SECRET authorizes no one
 * (401), so a misconfigured deployment cannot expose a scan that reads every
 * workspace's spend. Same check as /api/cron/agent-model-eval's cron path.
 *
 * Never 500s: a failed read returns 200 with degraded: true, so the cron
 * monitor stays green AND the response says the scan did not happen, rather
 * than reporting a clean zero it did not measure.
 */
import { NextResponse } from "next/server";
import { isAuthorizedBearer } from "@/lib/auth/bearer-auth";
import { runSpendAnomalyScan, liveSpendAnomalyDeps } from "@/lib/ai/spend-anomaly";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isAuthorizedBearer(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await runSpendAnomalyScan(liveSpendAnomalyDeps());
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[cron/ai-spend-anomaly]", (err as Error).message);
    return NextResponse.json({ ok: true, degraded: true, scanned: 0, detected: 0, dispatched: 0 });
  }
}
