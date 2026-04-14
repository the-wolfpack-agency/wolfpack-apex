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
    let instance;
    if (body.action === "complete") {
      instance = await completeStep(id, body.step_id, user.id, user.role);
    } else if (body.action === "uncomplete") {
      instance = await uncompleteStep(id, body.step_id, user.id, user.role);
    } else {
      return NextResponse.json({ error: "action must be 'complete' or 'uncomplete'" }, { status: 400 });
    }
    return NextResponse.json({ instance });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
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
    const instance = await cancelOnboarding(id, user.id, user.role);
    return NextResponse.json({ instance });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
