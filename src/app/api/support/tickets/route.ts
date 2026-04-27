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
  setTicketCategory,
} from "@/lib/support/repo";
import {
  findMatchingPatterns,
  generateDraftResponse,
} from "@/lib/support/pattern-library";
import { categorizeTicket } from "@/lib/support/categorizer";

const VALID_STATUSES = ["open", "drafted", "sent", "closed", "all"] as const;
const VALID_AUDIENCES = ["client", "internal"] as const;
type AudienceLiteral = (typeof VALID_AUDIENCES)[number];

function isValidAudience(v: unknown): v is AudienceLiteral {
  return typeof v === "string"
    && (VALID_AUDIENCES as readonly string[]).includes(v);
}

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "automations.run");
  if (!auth.ok) return auth.response;

  try {
    const url = new URL(req.url);
    const statusParam = url.searchParams.get("status");
    const categoryParam = url.searchParams.get("category");
    const audienceParam = url.searchParams.get("audience");
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
    /* Unknown audience values silently fall back to no filter. The
       create + patch endpoints validate strictly because they're
       writes; reads stay forgiving so a stale bookmarked URL doesn't
       400 the dashboard. */
    const audience = isValidAudience(audienceParam) ? audienceParam : undefined;

    const tickets = await listTickets({ status, category, audience, limit });

    trackEvent("support.list_viewed", auth.user.id, auth.user.role, {
      status: status ?? "",
      category: category ?? "",
      audience: audience ?? "",
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

  /* Audience: only validate when the caller actually supplied one.
     Missing → default to 'internal' so the legacy clients (curl, old
     scripts) keep working. Present-but-invalid → 400 so a typo never
     silently lands as the wrong audience. */
  let audience: "client" | "internal" = "internal";
  if (b.audience !== undefined) {
    if (!isValidAudience(b.audience)) {
      return NextResponse.json(
        { error: "invalid_audience" },
        { status: 400 },
      );
    }
    audience = b.audience;
  }

  try {
    let ticket = await createTicket({
      title,
      body: ticketBody,
      diagnostic_text,
      category,
      severity,
      audience,
      status: "open",
      created_by_user_id: auth.user.id,
      created_by_email: auth.user.email,
    });

    /* AI auto-categorization. Runs BEFORE draft generation so the
       drafter can later inform itself from the chosen category and so
       the operator-facing UI shows the AI category from the very first
       render of the ticket page. Skipped when the operator picked a
       category explicitly (anything other than missing or 'general')
       so a deliberate operator pick is never overwritten by the AI.
       Wrapped in try/catch — categorization failure must NOT block
       ticket creation. */
    const operatorPickedCategory =
      typeof category === "string"
      && category.trim().length > 0
      && category.trim() !== "general";

    if (!operatorPickedCategory) {
      try {
        const result = await categorizeTicket({
          title,
          body: ticketBody,
          diagnostic_text: diagnostic_text ?? undefined,
        });
        await setTicketCategory(
          ticket.id,
          result.category,
          "ai",
          result.confidence,
        );
        /* Re-load the ticket so the response payload reflects the new
           category metadata. updateTicket below would clobber category
           if we passed it in, so we go through setTicketCategory and
           pull the fresh row through the next updateTicket call. */
        ticket = {
          ...ticket,
          category: result.category,
          category_source: "ai",
          category_confidence: result.confidence,
        };

        trackEvent("support.categorized", auth.user.id, auth.user.role, {
          ticket_id: String(ticket.id),
          category: result.category,
          confidence: result.confidence,
          source: "ai",
        });
      } catch (err) {
        /* Defensive: any failure (AI down, DB hiccup) is logged and
           the ticket continues through draft generation with its
           original category. The categorizer itself never throws, so
           this block primarily guards setTicketCategory. */
        console.warn(
          "[support/tickets] auto-categorize failed:",
          (err as Error).message,
        );
      }
    }

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

    /* Report the operator-picked category when present (so legacy
       analytics dashboards keep their shape), and the AI-picked
       category when the operator left it blank/general. ticket.category
       carries the post-categorization value either way after our
       in-memory mirror above. */
    trackEvent("support.ticket_created", auth.user.id, auth.user.role, {
      ticket_id: String(ticket.id),
      category: operatorPickedCategory ? (category ?? "") : ticket.category,
      severity: severity ?? "",
      audience,
    });

    return NextResponse.json(updated ?? ticket, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
