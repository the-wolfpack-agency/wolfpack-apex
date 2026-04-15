import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getClient, updateClient } from "@/lib/clients";

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
