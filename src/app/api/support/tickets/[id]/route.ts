/**
 * GET    /api/support/tickets/[id] — full ticket including matched patterns.
 * PATCH  /api/support/tickets/[id] — partial update of editable fields.
 * DELETE /api/support/tickets/[id] — remove a ticket.
 *
 * Auth: `automations.run` capability.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import {
  getTicket,
  updateTicket,
  deleteTicket,
} from "@/lib/support/repo";
import * as repo from "@/lib/support/repo";

const PATCHABLE_FIELDS = [
  "title",
  "body",
  "diagnostic_text",
  "category",
  "severity",
  "status",
  "audience",
  "draft_response",
  "sent_to_email",
] as const;

const VALID_AUDIENCES = ["client", "internal"] as const;

export async function GET(
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

    /* Hydrate the email/message thread when the parallel-shipped repo
       function is available. Until that lands we degrade to an empty
       array so the UI render branch stays stable and the response shape
       never depends on whether the new repo helper has been merged. */
    let thread: unknown[] = [];
    const maybeList = (repo as { listTicketMessages?: unknown })
      .listTicketMessages;
    if (typeof maybeList === "function") {
      try {
        const result = await (maybeList as (
          ticketId: string,
        ) => Promise<unknown[]>)(id);
        if (Array.isArray(result)) thread = result;
      } catch {
        /* Swallow — a thread fetch failure must not 500 the ticket
           detail page. We log via the empty array and let operators
           still see the ticket body + draft editor. */
        thread = [];
      }
    }

    return NextResponse.json({ ticket: { ...ticket, thread } });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "automations.run");
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "missing_body" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const field of PATCHABLE_FIELDS) {
    if (field in b) patch[field] = b[field];
  }
  /* Audience patches are validated strictly. The DB CHECK constraint
     would catch the bad value too, but a 400 here gives the operator a
     clear error instead of a generic 500. */
  if ("audience" in patch) {
    if (
      typeof patch.audience !== "string"
      || !(VALID_AUDIENCES as readonly string[]).includes(patch.audience)
    ) {
      return NextResponse.json(
        { error: "invalid_audience" },
        { status: 400 },
      );
    }
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { error: "no_fields_to_update" },
      { status: 400 },
    );
  }

  try {
    const { id } = await ctx.params;
    const updated = await updateTicket(id, patch);
    if (!updated) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    trackEvent("support.ticket_updated", auth.user.id, auth.user.role, {
      ticket_id: id,
      fields_changed: Object.keys(patch).join(","),
    });

    return NextResponse.json({ ticket: updated });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "automations.run");
  if (!auth.ok) return auth.response;

  try {
    const { id } = await ctx.params;
    const ok = await deleteTicket(id);
    if (!ok) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
