/**
 * GET  /api/support/tickets — list tickets (filterable by status/category).
 * POST /api/support/tickets — create + auto-draft an AI response.
 *
 * Body (POST): { title, body, diagnostic_text?, category?, severity? }
 * Auth: `automations.run` capability.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import {
  createTicket,
  listTickets,
  updateTicket,
  listEnabledPatterns,
} from "@/lib/support/repo";
import {
  findMatchingPatterns,
  generateDraftResponse,
} from "@/lib/support/pattern-library";

const VALID_STATUSES = ["open", "drafted", "sent", "closed", "all"] as const;

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "automations.run");
  if (!auth.ok) return auth.response;

  try {
    const url = new URL(req.url);
    const statusParam = url.searchParams.get("status");
    const categoryParam = url.searchParams.get("category");
    const limitParam = parseInt(url.searchParams.get("limit") ?? "50", 10);
    const limit =
      Number.isFinite(limitParam) && limitParam > 0 && limitParam <= 500
        ? limitParam
        : 50;

    const status =
      statusParam && (VALID_STATUSES as readonly string[]).includes(statusParam)
        ? statusParam
        : undefined;
    const category =
      typeof categoryParam === "string" && categoryParam.length > 0
        ? categoryParam
        : undefined;

    const tickets = await listTickets({ status, category, limit });

    trackEvent("support.list_viewed", auth.user.id, auth.user.role, {
      status: status ?? "",
      category: category ?? "",
      count: tickets.length,
    });

    return NextResponse.json({ tickets, total: tickets.length });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "automations.run");
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json" },
      { status: 400 },
    );
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "missing_body" },
      { status: 400 },
    );
  }
  const b = body as Record<string, unknown>;
  const title = typeof b.title === "string" ? b.title.trim() : "";
  const ticketBody = typeof b.body === "string" ? b.body.trim() : "";
  if (!title || !ticketBody) {
    return NextResponse.json(
      { error: "title_and_body_required" },
      { status: 400 },
    );
  }
  const diagnostic_text =
    typeof b.diagnostic_text === "string" ? b.diagnostic_text : null;
  const category = typeof b.category === "string" ? b.category : null;
  const severity = typeof b.severity === "string" ? b.severity : null;

  try {
    const ticket = await createTicket({
      title,
      body: ticketBody,
      diagnostic_text,
      category,
      severity,
      status: "open",
      created_by_user_id: auth.user.id,
      created_by_email: auth.user.email,
    });

    const matchText = `${ticketBody}\n${diagnostic_text ?? ""}`;
    const enabled = await listEnabledPatterns();
    const patterns = findMatchingPatterns(matchText, enabled);
    const outcome = await generateDraftResponse({
      ticket,
      matchingPatterns: patterns,
    });
    const draft = outcome.ok ? outcome.draft : null;
    const patternIds = patterns.map((p) => p.id);

    const updated = await updateTicket(ticket.id, {
      status: "drafted",
      draft_response: draft,
      draft_generated_at: new Date().toISOString(),
      draft_pattern_ids: patternIds,
    });

    trackEvent("support.ticket_created", auth.user.id, auth.user.role, {
      ticket_id: String(ticket.id),
      category: category ?? "",
      severity: severity ?? "",
    });

    return NextResponse.json(updated ?? ticket, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
