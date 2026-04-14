/**
 * /api/people/onboarding — list active onboardings + start new onboarding.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { listActiveOnboardings, startOnboarding, listAllOnboardings } from "@/lib/onboarding";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const all = req.nextUrl.searchParams.get("all") === "true";
  const instances = all ? await listAllOnboardings() : await listActiveOnboardings();
  return NextResponse.json({ instances });
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  if (!body.employee_id || !body.template_id) {
    return NextResponse.json({ error: "employee_id and template_id required" }, { status: 400 });
  }

  try {
    const instance = await startOnboarding(body.employee_id, body.template_id, user.id, user.role);
    return NextResponse.json({ instance }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
