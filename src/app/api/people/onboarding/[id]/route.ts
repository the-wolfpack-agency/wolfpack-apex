/**
 * /api/people/onboarding/[id] — get, update step, or cancel an onboarding instance.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  getInstance,
  completeStep,
  uncompleteStep,
  cancelOnboarding,
} from "@/lib/onboarding";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const instance = await getInstance(id);
  if (!instance) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ instance });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  if (!body.step_id || !body.action) {
    return NextResponse.json({ error: "step_id and action required" }, { status: 400 });
  }

  try {
    const before = await getInstance(id);
    let instance;
    if (body.action === "complete") {
      instance = await completeStep(id, body.step_id, user.id, user.role);
    } else if (body.action === "uncomplete") {
      instance = await uncompleteStep(id, body.step_id, user.id, user.role);
    } else {
      return NextResponse.json({ error: "action must be 'complete' or 'uncomplete'" }, { status: 400 });
    }
    const meta = extractRequestMetadata(req);
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: body.action === "complete" ? "hr.onboarding.step_completed" : "hr.onboarding.step_uncompleted",
      resourceType: "onboarding_instance",
      resourceId: id,
      beforeState: before,
      afterState: instance,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    }).catch((e) => console.warn("[audit]", (e as Error).message));
    return NextResponse.json({ instance });
  } catch (err) {
    console.error("[people/onboarding/id]", (err as Error).message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  try {
    const before = await getInstance(id);
    const instance = await cancelOnboarding(id, user.id, user.role);
    const meta = extractRequestMetadata(req);
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "hr.onboarding.cancelled",
      resourceType: "onboarding_instance",
      resourceId: id,
      beforeState: before,
      afterState: instance,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    }).catch((e) => console.warn("[audit]", (e as Error).message));
    return NextResponse.json({ instance });
  } catch (err) {
    console.error("[people/onboarding/id]", (err as Error).message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
