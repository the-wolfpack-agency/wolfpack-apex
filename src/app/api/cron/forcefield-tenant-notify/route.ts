/**
 * Forcefield tenant notifications (Vercel cron, every 10 minutes, see
 * vercel.json): the first-evidence email, each confirmed tenant's immediate
 * incident alerts for its own site, and (13:00 UTC run) its daily digest. Every
 * email passes the recipient allowlist in tenant-mail.ts.
 *
 * PUBLIC: a Vercel cron endpoint, authorized by the optional CRON_SECRET bearer
 * (same posture as /api/cron/forcefield-alerts); it takes no input.
 *
 * Optional CRON_SECRET. Never throws; a failure reports 200 with ok:false so the
 * schedule keeps running and the failure is visible in the cron log.
 */
import { NextResponse } from "next/server";
import { isAuthorizedBearer } from "@/lib/auth/bearer-auth";
import { runTenantNotifications, liveTenantNotifyDeps } from "@/lib/forcefield-web/tenant-alerts";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (!isAuthorizedBearer(auth, secret)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const report = await runTenantNotifications(liveTenantNotifyDeps());
    return NextResponse.json({ ok: true, ...report });
  } catch (err) {
    return NextResponse.json({ ok: false, error: "run_failed", detail: ((err as Error)?.message ?? "unknown").slice(0, 200) });
  }
}
