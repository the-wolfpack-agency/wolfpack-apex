/**
 * /api/email-signatures — list and create signatures for the calling user.
 *
 * GET → returns the calling user's signatures, default-first by created_at desc.
 * POST → body { label, body, isDefault? } → creates a new signature for
 *        the calling user. Promotes prior default down atomically when
 *        isDefault=true (handled inside lib/email-signatures.ts).
 *
 * All routes scope by `user.id` from the JWT. A user cannot enumerate or
 * mutate another user's signatures.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import {
  listSignatures,
  createSignature,
  validateSignatureInput,
} from "@/lib/email-signatures";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const signatures = await listSignatures(user.id);
  return NextResponse.json({ signatures });
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { label?: unknown; body?: unknown; isDefault?: unknown };
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  let validated: { label: string; body: string };
  try {
    validated = validateSignatureInput(body);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 },
    );
  }

  try {
    const signature = await createSignature({
      userId: user.id,
      label: validated.label,
      body: validated.body,
      isDefault: body.isDefault === true,
    });
    trackEvent("microsoft.signature_created", user.id, user.role, {
      signature_id: signature.id,
      is_default: signature.isDefault,
      body_length: signature.body.length,
    });
    return NextResponse.json({ signature }, { status: 201 });
  } catch (err) {
    console.error(
      "[api/email-signatures] create failed:",
      (err as Error).message,
    );
    return NextResponse.json(
      { error: "Failed to create signature" },
      { status: 500 },
    );
  }
}
