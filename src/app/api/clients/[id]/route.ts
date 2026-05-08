import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getClient, updateClient, deleteClient } from "@/lib/clients";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { tripleWriteEvent } from "@/lib/triple-write";

/**
 * Admin roles get full edit/delete access regardless of capability overrides.
 * Matches the `/features` board semantics so sales + cto both see
 * consistent behavior across "owner-ish" records.
 */
function isAdminRole(role: string): boolean {
  return role === "cto" || role === "ceo" || role === "evp";
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "clients.view");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const client = await getClient(id);

  if (!client) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ client });
}

/**
 * PATCH retained for backwards compat with any existing callers that
 * send partial updates through the old verb. New clients should use PUT.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "clients.edit");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const body = await req.json();
  const client = await updateClient(id, body);

  if (!client) {
    return NextResponse.json({ error: "Not found or no changes" }, { status: 404 });
  }

  return NextResponse.json({ client });
}

/**
 * PUT /api/clients/[id] — edit a client record.
 *
 * Body: { name?, industry?, contact_email?, contact_name?, notes? }
 *
 * Auth: `clients.edit` capability OR admin (cto/ceo). Sales role has
 * `clients.edit` by default, so this covers the common owner flow; the
 * admin bypass lets CTO/CEO intervene on records even if their cap set
 * is scoped down via overrides. Audit log captures before/after state;
 * triple-write fanout keeps vector/graph in sync.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "clients.edit");
  if (!auth.ok) {
    // 401 stays 401 (no token). 403 stays 403 for authenticated users
    // without the capability AND not in an admin role.
    return auth.response;
  }
  const user = auth.user;
  const { id } = await params;

  const existing = await getClient(id);
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await req.json()) as {
    name?: unknown;
    industry?: unknown;
    contact_email?: unknown;
    contact_name?: unknown;
    notes?: unknown;
  };

  const updates: {
    name?: string;
    industry?: string;
    contact_email?: string;
    contact_name?: string;
    notes?: string;
  } = {};
  if (typeof body.name === "string" && body.name.trim().length > 0) {
    updates.name = body.name.trim();
  }
  if (typeof body.industry === "string") updates.industry = body.industry;
  if (typeof body.contact_email === "string") updates.contact_email = body.contact_email;
  if (typeof body.contact_name === "string") updates.contact_name = body.contact_name;
  if (typeof body.notes === "string") updates.notes = body.notes;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: "at least one field is required" },
      { status: 400 },
    );
  }

  const client = await updateClient(id, updates);
  if (!client) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "clients.edited",
      resourceType: "client",
      resourceId: id,
      beforeState: {
        name: existing.name,
        industry: existing.industry,
        contact_email: existing.contact_email,
        contact_name: existing.contact_name,
        notes: existing.notes,
      },
      afterState: {
        name: client.name,
        industry: client.industry,
        contact_email: client.contact_email,
        contact_name: client.contact_name,
        notes: client.notes,
      },
      ...extractRequestMetadata(req),
    });
  } catch (err) {
    console.error("[clients PUT audit]", (err as Error).message);
  }

  // Re-triple-write so vector/graph reflect the new client content.
  void tripleWriteEvent({
    event_type: "clients.edited",
    user_id: user.id,
    user_role: user.role,
    metadata: {
      client_id: id,
      name: client.name,
      industry: client.industry ?? "",
    },
  });

  return NextResponse.json({ ok: true, client }, { status: 200 });
}

/**
 * DELETE /api/clients/[id] — remove a client record.
 *
 * Auth: `clients.edit` capability OR admin (cto/ceo). Fires
 * `clients.deleted` and captures before-state in the audit log. Hard
 * delete for now — instinct_clients has no soft-delete column.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "clients.edit");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  // Extra defense: admin override for overrides-locked users. If
  // requireCapability gated us through then we're allowed. If we added
  // a stricter role-only path later this helper keeps the check DRY.
  if (!auth.capabilities.has("clients.edit") && !isAdminRole(user.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;

  const existing = await getClient(id);
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const ok = await deleteClient(id, user.id);
  if (!ok) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "clients.deleted",
      resourceType: "client",
      resourceId: id,
      beforeState: {
        name: existing.name,
        industry: existing.industry,
        contact_email: existing.contact_email,
        contact_name: existing.contact_name,
      },
      ...extractRequestMetadata(req),
    });
  } catch (err) {
    console.error("[clients DELETE audit]", (err as Error).message);
  }

  trackEvent("clients.deleted", user.id, user.role, { client_id: id });

  return NextResponse.json({ ok: true, id }, { status: 200 });
}
