/**
 * GET /api/automations/[automationId]/exceptions — list exceptions.
 *
 * Query params:
 *   - status: open | resolved | dismissed | all (default: open)
 *   - limit:  1..500 (default: 100)
 *
 * Auth: `automations.view` capability required.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAutomation } from "@/lib/automations/registry";
import { listExceptions } from "@/lib/automations/queries";

const VALID_STATUSES = ["open", "resolved", "dismissed", "all"] as const;
type ValidStatus = (typeof VALID_STATUSES)[number];

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
  const statusParam = (url.searchParams.get("status") ?? "open") as string;
  const status = (VALID_STATUSES as readonly string[]).includes(statusParam)
    ? (statusParam as ValidStatus)
    : "open";
  const limitParam = parseInt(url.searchParams.get("limit") ?? "100", 10);
  const limit = Number.isFinite(limitParam) ? limitParam : 100;

  const exceptions = await listExceptions({
    automationId: automation.id,
    status,
    limit,
  });
  return NextResponse.json({ exceptions });
}
