import { NextResponse } from "next/server";
import { evaluateLearnedSignatures } from "@/lib/forcefield/learned-signatures";
import { liveLearnedSignatureDeps } from "@/lib/forcefield/learned-signatures-live";

/**
 * Learned hostile-tradecraft signature pass (Vercel cron, see vercel.json).
 * Mines recurring tradecraft combos from caught hostiles, matches live operators,
 * counts shadow matches / false positives, auto-blocks on ENFORCING matches, and
 * promotes any shadow signature that has earned it. Optional CRON_SECRET. Never
 * throws; a DB blip reports 200 so the schedule keeps running.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await evaluateLearnedSignatures(liveLearnedSignatureDeps());
    return NextResponse.json({ ok: true, ...result });
  } catch {
    return NextResponse.json({ ok: true, mined: 0, shadow: 0, enforcing: 0, promoted: 0, operatorsAutoBlocked: 0, falsePositives: 0 });
  }
}
