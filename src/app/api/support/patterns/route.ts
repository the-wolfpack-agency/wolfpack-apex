/**
 * GET /api/support/patterns — list every support pattern (enabled and
 * disabled) for the operator-facing /support/patterns management page.
 *
 * Different from listEnabledPatterns at the repo layer (the runtime
 * matcher hot-path). This endpoint is the management view: operators
 * need to see disabled patterns so they can toggle them on / opt them
 * into auto-acknowledge.
 *
 * Response shape mirrors GET /api/support/tickets:
 *   { patterns: SupportPattern[], total: number }
 *
 * Auth: `automations.run` capability — same gate as the tickets
 * endpoints so operator role boundaries stay aligned.
 *
 * Analytics: `support.patterns_viewed` fires on every successful read so
 * the learning system sees how often operators visit the page (a proxy
 * for how much auto-ack management activity is happening).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { listAllPatterns } from "@/lib/support/repo";

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "automations.run");
  if (!auth.ok) return auth.response;

  try {
    const patterns = await listAllPatterns();

    trackEvent("support.patterns_viewed", auth.user.id, auth.user.role, {
      count: patterns.length,
      auto_ack_enabled_count: patterns.filter(
        (p) => p.auto_acknowledge_enabled === true,
      ).length,
    });

    return NextResponse.json({ patterns, total: patterns.length });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
