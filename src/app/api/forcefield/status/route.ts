/**
 * GET /api/forcefield/status - PUBLIC control-plane health.
 *
 * The honest, machine-readable health of the Forcefield control plane, for an
 * external uptime monitor / a status page and to make the SLA credible. Reports
 * whether the engine is up and the database is reachable. It is NOT a customer's
 * data (no token, no counts), just liveness.
 *
 * PUBLIC: unauthenticated by design (a status endpoint must be reachable without
 * a session). Cheap + short-cached so it cannot be used to hammer the DB. NEVER
 * 500s: a DB probe failure is reported as degraded with HTTP 200 so a monitor
 * reads a structured body, and the endpoint itself is always up.
 */
import { NextResponse } from "next/server";
import { safeQuery } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  let database = false;
  try {
    const res = await safeQuery<{ ok: number }>("SELECT 1 AS ok", []);
    database = res.rows.length > 0 && Number(res.rows[0].ok) === 1;
  } catch {
    database = false;
  }
  // Fail-open is the product's backbone: even a DB blip never takes a customer's
  // site down (the edge shim allows on error), so "degraded" here is honest, not
  // an outage for the protected sites.
  const status = database ? "ok" : "degraded";
  return NextResponse.json(
    { ok: true, status, engine: "ok", database, failOpen: true },
    { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=120" } },
  );
}
