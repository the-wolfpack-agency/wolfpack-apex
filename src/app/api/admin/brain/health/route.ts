/**
 * GET /api/admin/brain/health
 *
 * What the document pipeline is quietly failing to do, read live.
 *
 * Every check behind this endpoint is something that actually went wrong this
 * month and was found by hand, late: ten PDFs stuck mid-ingest since May,
 * ninety Word documents broken for three months after their parser was fixed,
 * and 744 of 795 answerable documents turning out to be demo fixtures the
 * assistant was answering from.
 *
 * None of those is a bug in a function, so no test could have caught them.
 * They are facts about accumulated state, which is work for a schedule rather
 * than for a person who happens to ask the right question.
 *
 * Read-only, so it is safe to poll and safe to hand to an agent.
 */
import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { readIngestionHealth, summarizeHealth } from "@/lib/brain/ingestion-health";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "ceo" && user.role !== "cto" && user.role !== "evp") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const health = await readIngestionHealth();
  return NextResponse.json(
    { ...health, summary: summarizeHealth(health) },
    { status: 200, headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
