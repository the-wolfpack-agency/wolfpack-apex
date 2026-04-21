import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getConnectionStatus as getMsStatus } from "@/lib/microsoft-graph";
import { getConnectionStatus as getQboStatus } from "@/lib/quickbooks";
import {
  getConnectionStatus as getPlaudStatus,
  isPlaudConfigured,
} from "@/lib/plaud";

/**
 * GET /api/integrations/status
 *
 * Aggregate connection status across all third-party integrations.
 * Consumers (Tasks page, Planner page) gate their empty-state vs.
 * data-view on the `microsoft.connected` flag; previously the
 * endpoint did not exist and the fetch quietly 404'd, pinning
 * every user to the "Connect Microsoft To Do" empty state even
 * after a successful OAuth handshake.
 *
 * Response shape is intentionally nested per provider so new
 * integrations can add themselves without breaking existing
 * consumers. `connected: boolean` is the contract.
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [microsoft, quickbooks, plaud] = await Promise.all([
    getMsStatus(user.id).catch(() => ({ connected: false, mode: "live" as const })),
    getQboStatus().catch(() => ({ connected: false })),
    getPlaudStatus().catch(() => ({ connected: false })),
  ]);

  return NextResponse.json({
    microsoft,
    quickbooks,
    plaud: { ...plaud, configured: isPlaudConfigured() },
  });
}
