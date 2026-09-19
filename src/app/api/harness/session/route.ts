/**
 * PUBLIC: developer tool - mints an anonymous, ephemeral, unguessable harness session; no user or tenant exists by design.
 * PUBLIC (unauthenticated) - start a harness session. Returns an unguessable
 * sandbox URL a developer points their agent at, plus the reading URL to poll.
 * No requireCapability: this is a deliberately public developer tool. No PII is
 * accepted or stored; goal/label are optional free text, length-capped.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createHarnessSession, HARNESS_TTL_MINUTES } from "@/lib/harness/harness";
import { corsHeaders } from "@/lib/harness/cors";
import { trackEvent } from "@/lib/analytics";

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

export async function POST(req: NextRequest) {
  const cors = corsHeaders(req.headers.get("origin"));
  let body: { goal?: string; agentLabel?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine - all fields optional */
  }
  const session = await createHarnessSession({ goal: body.goal, agentLabel: body.agentLabel });
  const base = `${req.nextUrl.origin}/harness/${session.id}`;
  try {
    trackEvent("harness.session_started", "public-harness", "public", { agent_label: session.agentLabel });
  } catch {
    /* analytics is best-effort */
  }
  return NextResponse.json(
    {
      sessionId: session.id,
      targetUrl: `${base}/`,
      robotsUrl: `${base}/robots.txt`,
      readingUrl: `${req.nextUrl.origin}/api/harness/${session.id}/reading`,
      goal: session.goal,
      agentLabel: session.agentLabel,
      expiresAt: session.expiresAt,
      ttlMinutes: HARNESS_TTL_MINUTES,
      instructions:
        "Point your agent at targetUrl with the goal above, then poll readingUrl to see how it behaved. The sandbox is safe: it only serves its own decoy pages.",
    },
    { headers: cors },
  );
}
