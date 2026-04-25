/**
 * POST /api/automations/[automationId]/override — record a manual
 * correction (alias / exclude / class_match).
 *
 * Body shape:
 *   { kind: OverrideKind, from: string, to: string, reason?: string }
 *
 * Auth: `automations.override` capability required.
 *
 * The override row is persisted with `created_by = user.email` so we
 * can audit who made which correction. An analytics event is emitted
 * for every successful insert.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAutomation } from "@/lib/automations/registry";
import { insertOverride, listOverrides } from "@/lib/automations/queries";
import { trackEvent } from "@/lib/analytics";
import type { OverrideKind } from "@/lib/automations/types";

const VALID_KINDS: ReadonlySet<OverrideKind> = new Set([
  "class_match",
  "participant_alias",
  "exclude_class",
  "exclude_participant",
]);

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ automationId: string }> },
) {
  const auth = await requireCapability(req, "automations.view");
  if (!auth.ok) return auth.response;
  const { automationId } = await ctx.params;
  const automation = getAutomation(automationId);
  if (!automation) {
    return NextResponse.json({ error: "automation not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  const kindParam = url.searchParams.get("kind");
  const kind =
    kindParam && VALID_KINDS.has(kindParam as OverrideKind)
      ? (kindParam as OverrideKind)
      : undefined;
  const overrides = await listOverrides({ automationId: automation.id, kind });
  return NextResponse.json({ overrides });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ automationId: string }> },
) {
  const auth = await requireCapability(req, "automations.override");
  if (!auth.ok) return auth.response;

  const { automationId } = await ctx.params;
  const automation = getAutomation(automationId);
  if (!automation) {
    return NextResponse.json({ error: "automation not found" }, { status: 404 });
  }

  let body: {
    kind?: string;
    from?: string;
    to?: string;
    reason?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.kind || !VALID_KINDS.has(body.kind as OverrideKind)) {
    return NextResponse.json(
      { error: `kind must be one of ${[...VALID_KINDS].join(", ")}` },
      { status: 400 },
    );
  }
  if (typeof body.from !== "string" || body.from.length === 0) {
    return NextResponse.json({ error: "from is required" }, { status: 400 });
  }
  if (typeof body.to !== "string" || body.to.length === 0) {
    return NextResponse.json({ error: "to is required" }, { status: 400 });
  }

  const override = await insertOverride({
    automationId: automation.id,
    kind: body.kind as OverrideKind,
    fromValue: body.from,
    toValue: body.to,
    reason: body.reason ?? null,
    createdBy: auth.user.email,
  });

  trackEvent("automations.override_applied", auth.user.id, auth.user.role, {
    automation_id: automation.id,
    kind: override.kind,
  });

  return NextResponse.json({ override }, { status: 201 });
}
