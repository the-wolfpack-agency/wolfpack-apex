/**
 * /api/people/onboarding/templates — list + create onboarding templates.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { listTemplates, createTemplate } from "@/lib/onboarding";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const templates = await listTemplates();
  return NextResponse.json({ templates });
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  if (!body.name || !body.steps || !Array.isArray(body.steps) || body.steps.length === 0) {
    return NextResponse.json({ error: "name and steps (non-empty array) required" }, { status: 400 });
  }

  try {
    const template = await createTemplate(body.name, body.steps, user.id, user.role, body.department);
    return NextResponse.json({ template }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
