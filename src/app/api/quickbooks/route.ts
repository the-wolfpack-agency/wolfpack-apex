import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import {
  getAuthUrl,
  getConnectionStatus,
  deleteTokens,
  fetchProfitAndLoss,
  fetchBalanceSheet,
  fetchCashFlow,
  fetchAgedReceivables,
  fetchAgedPayables,
  fetchUnpaidInvoices,
  fetchRecentPayments,
  fetchCompanyInfo,
} from "@/lib/quickbooks";

/**
 * GET /api/quickbooks
 *
 * Query params:
 *   ?action=auth-url   — Return the OAuth2 authorization URL
 *   ?action=status     — Return connection status
 *   (no action)        — Return full financial dashboard data
 */
export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "finance.reports.view");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  // --- Auth URL ---
  if (action === "auth-url") {
    const authUrl = getAuthUrl();
    return NextResponse.json({ authUrl });
  }

  // --- Connection status ---
  if (action === "status") {
    const status = await getConnectionStatus();
    return NextResponse.json(status);
  }

  // --- Full financial dashboard ---
  trackEvent("system.page_viewed", user.id, user.role, {
    page: "quickbooks",
    module: "quickbooks",
  });

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .split("T")[0];
  const today = now.toISOString().split("T")[0];

  const [
    profitAndLoss,
    balanceSheet,
    cashFlow,
    agedReceivables,
    agedPayables,
    unpaidInvoices,
    recentPayments,
    companyInfo,
    connectionStatus,
  ] = await Promise.all([
    fetchProfitAndLoss(startOfMonth, today),
    fetchBalanceSheet(),
    fetchCashFlow(startOfMonth, today),
    fetchAgedReceivables(),
    fetchAgedPayables(),
    fetchUnpaidInvoices(),
    fetchRecentPayments(10),
    fetchCompanyInfo(),
    getConnectionStatus(),
  ]);

  trackEvent("quickbooks.sync_completed", user.id, user.role, {
    mode: connectionStatus.mode,
  });

  return NextResponse.json({
    connection: connectionStatus,
    profitAndLoss,
    balanceSheet,
    cashFlow,
    agedReceivables,
    agedPayables,
    unpaidInvoices,
    recentPayments,
    companyInfo,
  });
}

/**
 * POST /api/quickbooks
 *
 * Body:
 *   { action: "disconnect" }  — Clear stored QBO tokens
 */
export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "finance.connect");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  try {
    const body = await req.json();

    if (body.action === "disconnect") {
      await deleteTokens();

      trackEvent("quickbooks.disconnected", user.id, user.role, {
        module: "quickbooks",
      });

      const meta = extractRequestMetadata(req);
      await recordAudit({
        actor: { user_id: user.id, role: user.role },
        action: "integration.quickbooks.disconnected",
        resourceType: "integration",
        resourceId: "quickbooks",
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      }).catch((e) => console.warn("[audit]", (e as Error).message));

      return NextResponse.json({ success: true, message: "QuickBooks disconnected" });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
