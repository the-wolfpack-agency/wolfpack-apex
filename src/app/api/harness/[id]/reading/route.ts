/**
 * PUBLIC: developer tool - returns the caller's own anonymous harness reading; no PII, no tenant, no durable state.
 * PUBLIC (unauthenticated) - the behavioral reading for a session, rebuilt from
 * recorded hits via the shared engine (journey + scaffolding + operator dossier,
 * with the proven-vs-inferred rail and the not-a-real-identity disclaimer). No
 * requireCapability: the reading contains only the developer's own agent run and
 * no PII. Polled by the ogiam.com front end.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getHarnessReading, HARNESS_WORKSPACE } from "@/lib/harness/harness";
import { corsHeaders } from "@/lib/harness/cors";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const cors = corsHeaders(req.headers.get("origin"));
  const { id } = await ctx.params;
  const result = await getHarnessReading(id, HARNESS_WORKSPACE);
  if (!result.ok) {
    return NextResponse.json({ error: "unknown_session" }, { status: 404, headers: cors });
  }
  return NextResponse.json({ reading: result.reading, expired: result.expired }, { headers: cors });
}
