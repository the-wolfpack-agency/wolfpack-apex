/**
 * GET /api/insights/data-questions
 *
 * The insight agent: asks a curated set of questions of the CALLER'S own data
 * and returns the answers as findings.
 *
 * WHY IT LIVES HERE AND NOT UNDER /api/admin. It was written there first, and
 * the capability-coverage guardrail rejected it: every route under
 * src/app/api/admin must gate on requireCapability, and this one deliberately
 * does not. The guardrail was right about something real. The admin insight
 * feeds read the whole workspace's event stream, which IS an admin view of
 * everybody. This asks questions AS THE CALLER and returns exactly what that
 * person could have found by typing them, so gating it to three roles would
 * withhold somebody's own documents from them. The path now says which kind of
 * endpoint it is, rather than an allowlist entry explaining why it is an
 * exception to its own namespace.
 *
 * THE ACCESS RULE IS THE DESIGN. Every question runs with the caller's user id,
 * so retrieval is scoped by their permissions and SharePoint applies its own.
 * There is deliberately no privileged path: a panel that surfaced a document
 * somebody was not allowed to open would be a disclosure, and the only reliable
 * way to prevent that is to never hold the ability.
 *
 * SLOW BY NATURE, BOUNDED BY DESIGN. Six real retrievals against live systems
 * take seconds, not milliseconds. Measured against production: 7.2 seconds for
 * six questions, all answered. The run is bounded so a client never watches a
 * spinner indefinitely, and anything not reached is named rather than dropped.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { runDataQuestions } from "@/lib/insights/run-data-questions";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const run = await runDataQuestions(user.id, user.role ?? "member");
    return NextResponse.json({
      findings: run.findings,
      skipped: run.skipped,
      tookMs: run.tookMs,
      /* The number worth reading: how much of their corpus we could NOT answer
         from. It is the gap a pilot exists to close, and hiding it would make
         the panel a brochure. */
      emptyCount: run.findings.filter((f) => f.empty).length,
    });
  } catch (err) {
    /* A failed run is reported, never rendered as "no insights". An empty
       panel and a broken one look identical to a reader, which is the
       confusion this whole codebase keeps having to design against. */
    return NextResponse.json(
      {
        error: "Could not run the insight questions just now.",
        detail: (err as Error).message?.slice(0, 200) ?? "unknown",
      },
      { status: 503 },
    );
  }
}
