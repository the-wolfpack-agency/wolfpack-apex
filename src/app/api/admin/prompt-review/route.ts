/**
 * POST /api/admin/prompt-review - what a task brief left unsaid.
 *
 * A POST because the brief is in the body, not because anything is written. It
 * is deterministic and free (no model call), so the only reason it is not a GET
 * is that briefs do not belong in a URL: query strings land in access logs, in
 * browser history and in referrer headers, and a brief routinely names a client.
 *
 * THE BRIEF IS NEVER STORED
 *
 * Only the shape of the result is recorded: how many findings, and which
 * dimensions. Aggregated across a team that answers "which fact do we most often
 * leave out", which is more useful than any single review, and it does it
 * without keeping text that can carry client detail.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { reviewPrompt } from "@/lib/agents/prompt-review";
import { trackEvent } from "@/lib/analytics";

export const runtime = "nodejs";

/** Long enough for any real brief, bounded so a request cannot hand the regex
 *  engine an unbounded string. */
const MAX_CHARS = 20_000;

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body with a `text` field." }, { status: 400 });
  }

  const text = (body as { text?: unknown })?.text;
  if (typeof text !== "string") {
    return NextResponse.json({ error: "Expected a JSON body with a `text` field." }, { status: 400 });
  }
  if (text.length > MAX_CHARS) {
    return NextResponse.json({ error: `A brief is limited to ${MAX_CHARS} characters.` }, { status: 400 });
  }

  const review = reviewPrompt(text);

  trackEvent("agent.brief_reviewed", auth.user.id, auth.user.role, {
    findings: review.findings.length,
    dimensions: review.findings.map((f) => f.dimension).join(","),
    chars: text.length,
  });

  return NextResponse.json(review, { status: 200 });
}
