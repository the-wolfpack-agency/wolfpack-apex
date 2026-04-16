/**
 * PATCH  /api/contacts/[id] — update contact (write-through).
 * DELETE /api/contacts/[id] — delete contact.
 *
 * `id` is the Graph ms_contact_id (opaque). The mirror row is identified
 * by (user_id, ms_contact_id) so we pass it through directly.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  updateContact,
  deleteContact,
  GraphContactsError,
  UpdateContactInput,
} from "@/lib/integrations/microsoft-contacts";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  let body: UpdateContactInput;
  try { body = (await req.json()) as UpdateContactInput; } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  if (body.emailAddresses !== undefined && !Array.isArray(body.emailAddresses)) {
    return NextResponse.json({ error: "emailAddresses must be an array" }, { status: 400 });
  }
  if (body.phoneNumbers !== undefined && !Array.isArray(body.phoneNumbers)) {
    return NextResponse.json({ error: "phoneNumbers must be an array" }, { status: 400 });
  }

  try {
    const out = await updateContact(user.id, id, body, { user_id: user.id, role: user.role });
    return NextResponse.json({ contact: out });
  } catch (err) {
    if (err instanceof GraphContactsError) {
      if (err.status === 401) return NextResponse.json({ error: "Microsoft not connected" }, { status: 401 });
      if (err.status === 403) return NextResponse.json({ error: "scope_missing", scope: "Contacts.ReadWrite" }, { status: 403 });
      if (err.status === 404) return NextResponse.json({ error: "Not found" }, { status: 404 });
      return NextResponse.json({ error: err.message }, { status: err.status >= 500 ? 502 : err.status });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  try {
    await deleteContact(user.id, id, { user_id: user.id, role: user.role });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof GraphContactsError) {
      if (err.status === 401) return NextResponse.json({ error: "Microsoft not connected" }, { status: 401 });
      if (err.status === 403) return NextResponse.json({ error: "scope_missing", scope: "Contacts.ReadWrite" }, { status: 403 });
      if (err.status === 404) return NextResponse.json({ error: "Not found" }, { status: 404 });
      return NextResponse.json({ error: err.message }, { status: err.status >= 500 ? 502 : err.status });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
