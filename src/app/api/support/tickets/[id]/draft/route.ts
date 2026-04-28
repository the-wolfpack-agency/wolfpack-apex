/**
 * POST /api/support/tickets/[id]/draft — regenerate the AI draft response.
 *
 * Re-runs pattern matching + draft generation against the current ticket
 * body + diagnostic_text, persists the new draft, transitions the ticket
 * to status='drafted', and returns the updated row.
 *
 * Auth: `automations.run` capability.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import {
  getTicket,
  updateTicket,
  listEnabledPatterns,
  setTicketCacheIds,
} from "@/lib/support/repo";
import {
  findMatchingPatterns,
  generateDraftResponse,
} from "@/lib/support/pattern-library";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "automations.run");
  if (!auth.ok) return auth.response;

  try {
    const { id } = await ctx.params;
    const ticket = await getTicket(id);
    if (!ticket) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const matchText = `${ticket.body ?? ""}\n${ticket.diagnostic_text ?? ""}`;
    const enabled = await listEnabledPatterns();
    const patterns = findMatchingPatterns(matchText, enabled);
    const outcome = await generateDraftResponse({
      ticket,
      matchingPatterns: patterns,
    });
    const draft = outcome.ok ? outcome.draft : null;
    const patternIds = patterns.map((p) => p.id);

    const updated = await updateTicket(id, {
      status: "drafted",
      draft_response: draft,
      draft_generated_at: new Date().toISOString(),
      draft_pattern_ids: patternIds,
    });

    /* Stash the draft cache id on the ticket so the feedback handler
       can vote on it later. Best-effort. */
    if (outcome.ok && outcome.cache_id) {
      try {
        await setTicketCacheIds(id, { draft: outcome.cache_id });
      } catch {
        /* learning-loop loss only; never block draft regeneration */
      }
    }

    trackEvent("support.draft_generated", auth.user.id, auth.user.role, {
      ticket_id: id,
      pattern_ids: patternIds.join(","),
      char_count: typeof draft === "string" ? draft.length : 0,
    });

    return NextResponse.json({ ticket: updated ?? ticket });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
