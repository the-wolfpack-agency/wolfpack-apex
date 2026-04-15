import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getClients, createClient } from "@/lib/clients";

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "clients.view");
  if (!auth.ok) return auth.response;

  const clients = await getClients();
  return NextResponse.json({ clients });
}

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "clients.edit");
  if (!auth.ok) return auth.response;

  const body = await req.json();
  const { name, industry, contact_email, contact_name, notes } = body;

  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const client = await createClient(name, industry, contact_email, contact_name, notes);
  return NextResponse.json({ client }, { status: 201 });
}
