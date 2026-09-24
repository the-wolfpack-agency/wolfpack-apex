import { NextResponse } from "next/server";
import { refreshDatacenterPrefixes } from "@/lib/forcefield/datacenter-ranges";

/**
 * Weekly refresh of the datacenter prefix set from the providers' published
 * lists (Vercel cron, see vercel.json). Keeps the ruleset-distributed coverage
 * current for EVERY site at once. Optional CRON_SECRET; never throws (a failed
 * fetch keeps the existing set rather than wiping it).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const written = await refreshDatacenterPrefixes();
    return NextResponse.json({ ok: true, prefixes: written });
  } catch {
    return NextResponse.json({ ok: true, prefixes: 0 });
  }
}
