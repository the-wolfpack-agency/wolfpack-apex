/**
 * Plaud connection management.
 *
 * GET  /api/integrations/plaud?action=status     — current connection status
 * POST /api/integrations/plaud                    — body { action: "connect" | "disconnect" }
 *
 * The actual API key + webhook secret live in environment variables
 * (PLAUD_API_KEY, PLAUD_WEBHOOK_SECRET). The "connect" action just
 * records WHO connected so we have an audit trail.
 *
 * Future enhancement: programmatically register the webhook URL with
 * Plaud's API on connect, instead of asking the user to do it manually
 * in the Plaud Developer Portal.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import {
  isPlaudConfigured,
  recordConnection,
  deleteConnection,
  getConnectionStatus,
} from "@/lib/plaud";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  if (action === "status" || !action) {
    const status = await getConnectionStatus();
    return NextResponse.json({
      ...status,
      configured: isPlaudConfigured(),
    });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.action === "connect") {
    if (!isPlaudConfigured()) {
      return NextResponse.json(
        { error: "Plaud not configured: PLAUD_API_KEY and PLAUD_WEBHOOK_SECRET must be set" },
        { status: 400 },
      );
    }
    await recordConnection(user.id, user.name);
    trackEvent("plaud.connected", user.id, user.role, { module: "plaud" });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "disconnect") {
    await deleteConnection();
    trackEvent("plaud.disconnected", user.id, user.role, { module: "plaud" });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
