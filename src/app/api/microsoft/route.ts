import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import {
  getAuthUrl,
  getConnectionStatus,
  deleteTokens,
  fetchCalendarEvents,
  fetchRecentEmails,
  fetchEmailsFromContact,
  fetchUnreadCount,
  fetchUserProfile,
} from "@/lib/microsoft-graph";

/**
 * GET /api/microsoft
 *
 * Available to all authenticated users. Each user connects their own
 * Microsoft 365 account via Settings > Integrations.
 *
 * Query params:
 *   ?action=auth-url            — Return the OAuth2 authorization URL
 *   ?action=status              — Return connection status
 *   ?action=emails-from&email=… — Return emails from a specific contact
 *   (no action)                 — Return calendar, emails, unread count, profile
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  // --- Auth URL ---
  if (action === "auth-url") {
    const authUrl = getAuthUrl(user.id);
    return NextResponse.json({ authUrl });
  }

  // --- Connection status ---
  if (action === "status") {
    const status = await getConnectionStatus(user.id);
    return NextResponse.json(status);
  }

  // --- Emails from a specific contact ---
  if (action === "emails-from") {
    const email = url.searchParams.get("email");
    if (!email) {
      return NextResponse.json({ error: "Missing email parameter" }, { status: 400 });
    }

    const emails = await fetchEmailsFromContact(user.id, email);
    return NextResponse.json({ emails });
  }

  // --- Full Microsoft dashboard data ---
  trackEvent("system.page_viewed", user.id, user.role, {
    page: "microsoft",
    module: "microsoft-graph",
  });

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString().split("T")[0];
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString().split("T")[0];

  const [
    calendarEvents,
    recentEmails,
    unreadCount,
    userProfile,
    connectionStatus,
  ] = await Promise.all([
    fetchCalendarEvents(user.id, todayStart, todayEnd),
    fetchRecentEmails(user.id, 18),
    fetchUnreadCount(user.id),
    fetchUserProfile(user.id),
    getConnectionStatus(user.id),
  ]);

  trackEvent("microsoft.sync_completed", user.id, user.role, {
    mode: connectionStatus.mode,
  });

  return NextResponse.json({
    connection: connectionStatus,
    calendarEvents,
    recentEmails,
    unreadCount,
    userProfile,
  });
}

/**
 * POST /api/microsoft
 *
 * Body:
 *   { action: "disconnect" }  — Clear stored Microsoft tokens
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Client sends ?action=disconnect on the URL and no body. Read from
    // either source — body first (future-compat), query param as fallback.
    let action: string | undefined;
    try {
      const body = await req.json();
      action = body?.action;
    } catch {
      action = undefined;
    }
    if (!action) {
      action = new URL(req.url).searchParams.get("action") ?? undefined;
    }

    if (action === "disconnect") {
      await deleteTokens(user.id);

      trackEvent("microsoft.disconnected", user.id, user.role, {
        module: "microsoft-graph",
      });

      const meta = extractRequestMetadata(req);
      await recordAudit({
        actor: { user_id: user.id, role: user.role },
        action: "integration.microsoft.disconnected",
        resourceType: "integration",
        resourceId: "microsoft-graph",
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      }).catch((e) => console.warn("[audit]", (e as Error).message));

      return NextResponse.json({ success: true, message: "Microsoft account disconnected" });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
