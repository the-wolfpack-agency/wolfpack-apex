/**
 * GET  /api/contacts — list from mirror.
 * POST /api/contacts — create (write-through Graph + mirror).
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  listContacts,
  createContact,
  GraphContactsError,
  CreateContactInput,
} from "@/lib/integrations/microsoft-contacts";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const limitStr = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const search = url.searchParams.get("search") ?? undefined;

  const limit = limitStr ? parseInt(limitStr, 10) : 50;
  if (Number.isNaN(limit) || limit < 1 || limit > 200) {
    return NextResponse.json({ error: "Invalid limit" }, { status: 400 });
  }

  const { contacts, nextCursor } = await listContacts(user.id, { limit, cursor, search });
  return NextResponse.json({ contacts, nextCursor });
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: CreateContactInput;
  try { body = (await req.json()) as CreateContactInput; } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  if (!body.displayName || typeof body.displayName !== "string" || body.displayName.trim().length === 0) {
    return NextResponse.json({ error: "displayName is required" }, { status: 400 });
  }
  if (body.emailAddresses && !Array.isArray(body.emailAddresses)) {
    return NextResponse.json({ error: "emailAddresses must be an array" }, { status: 400 });
  }
  if (body.phoneNumbers && !Array.isArray(body.phoneNumbers)) {
    return NextResponse.json({ error: "phoneNumbers must be an array" }, { status: 400 });
  }

  try {
    const out = await createContact(
      user.id,
      {
        displayName: body.displayName.trim(),
        givenName: body.givenName,
        surname: body.surname,
        emailAddresses: body.emailAddresses,
        phoneNumbers: body.phoneNumbers,
        companyName: body.companyName,
        jobTitle: body.jobTitle,
      },
      { user_id: user.id, role: user.role },
    );
    return NextResponse.json({ contact: out }, { status: 201 });
  } catch (err) {
    if (err instanceof GraphContactsError) {
      if (err.status === 401) return NextResponse.json({ error: "Microsoft not connected" }, { status: 401 });
      if (err.status === 403) return NextResponse.json({ error: "scope_missing", scope: "Contacts.ReadWrite" }, { status: 403 });
      if (err.status === 429) {
        return NextResponse.json(
          { error: "Microsoft Graph rate limit" },
          { status: 429, headers: err.retryAfter ? { "Retry-After": String(err.retryAfter) } : undefined },
        );
      }
      return NextResponse.json({ error: err.message }, { status: err.status >= 500 ? 502 : err.status });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
