/**
 * /api/people/onboarding — list active onboardings + start new onboarding.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { listActiveOnboardings, startOnboarding, listAllOnboardings } from "@/lib/onboarding";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

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
    const meta = extractRequestMetadata(req);
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "hr.onboarding.started",
      resourceType: "onboarding_instance",
      resourceId: (instance as { id?: string } | null)?.id,
      afterState: {
        employee_id: body.employee_id,
        template_id: body.template_id,
      },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    }).catch((e) => console.warn("[audit]", (e as Error).message));
    return NextResponse.json({ instance }, { status: 201 });
  } catch (err) {
    console.error("[people/onboarding]", (err as Error).message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
