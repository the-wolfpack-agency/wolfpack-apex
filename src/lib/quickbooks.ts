/**
 * QuickBooks Online Integration — OAuth2 + Financial Data Fetchers.
 *
 * Connects to QBO via OAuth2 and fetches financial reports:
 *   P&L, Balance Sheet, Cash Flow, AR/AP Aging, Invoices, Payments.
 *
 * Shadow mode: returns realistic demo data when QBO_CLIENT_ID is not set.
 * All API calls are tracked via analytics and cached with 15-minute TTL.
 */

import { safeQuery, query } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QboTokens {
  access_token: string;
  refresh_token: string;
  realm_id: string;
  expires_at: string;
  company_name?: string;
}

export interface ProfitAndLoss {
  startDate: string;
  endDate: string;
  totalIncome: number;
  totalExpenses: number;
  netIncome: number;
  incomeCategories: { name: string; amount: number }[];
  expenseCategories: { name: string; amount: number }[];
}

export interface BalanceSheet {
  asOfDate: string;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  assets: { name: string; amount: number }[];
  liabilities: { name: string; amount: number }[];
  equity: { name: string; amount: number }[];
}

export interface CashFlow {
  startDate: string;
  endDate: string;
  operatingActivities: number;
  investingActivities: number;
  financingActivities: number;
  netCashChange: number;
}

export interface AgedSummary {
  current: number;
  days1to30: number;
  days31to60: number;
  days61to90: number;
  over90: number;
  total: number;
  details: { name: string; current: number; days1to30: number; days31to60: number; days61to90: number; over90: number; total: number }[];
}

export interface Invoice {
  id: string;
  customerName: string;
  amount: number;
  balance: number;
  dueDate: string;
  status: string;
}

export interface Payment {
  id: string;
  customerName: string;
  amount: number;
  date: string;
  method: string;
}

export interface CompanyInfo {
  companyName: string;
  legalName: string;
  fiscalYearStart: string;
  country: string;
  email: string;
  phone: string;
}

export interface ConnectionStatus {
  connected: boolean;
  companyName: string | null;
  realmId: string | null;
  lastSync: string | null;
  mode: "live" | "shadow";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QBO_BASE_URL = "https://quickbooks.api.intuit.com/v3";
const QBO_AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const QBO_MINOR_VERSION = 75;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Clear all cached QBO data. */
export function clearCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Shadow mode check
// ---------------------------------------------------------------------------

function isShadowMode(): boolean {
  return !process.env.QBO_CLIENT_ID;
}

// ---------------------------------------------------------------------------
// OAuth2 Helpers
// ---------------------------------------------------------------------------

/**
 * Generate the QuickBooks OAuth2 authorization URL.
 * The user should be redirected here to initiate the connection.
 */
export function getAuthUrl(state?: string): string {
  const clientId = process.env.QBO_CLIENT_ID;
  const redirectUri = process.env.QBO_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return "";
  }

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    scope: "com.intuit.quickbooks.accounting",
    redirect_uri: redirectUri,
    state: state || "apex-qbo",
  });

  return `${QBO_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange an authorization code for access + refresh tokens.
 */
export async function exchangeCode(code: string, realmId: string): Promise<QboTokens | null> {
  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  const redirectUri = process.env.QBO_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) return null;

  try {
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const res = await fetch(QBO_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth}`,
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });

    if (!res.ok) {
      console.error("[quickbooks] Token exchange failed:", res.status, await res.text());
      return null;
    }

    const data = await res.json();
    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      realm_id: realmId,
      expires_at: expiresAt,
    };
  } catch (err) {
    console.error("[quickbooks] Token exchange error:", (err as Error).message);
    return null;
  }
}

/**
 * Refresh an expired access token using the refresh token.
 */
export async function refreshToken(currentRefreshToken: string): Promise<QboTokens | null> {
  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;

  if (!clientId || !clientSecret) return null;

  try {
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const res = await fetch(QBO_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth}`,
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: currentRefreshToken,
      }).toString(),
    });

    if (!res.ok) {
      console.error("[quickbooks] Token refresh failed:", res.status, await res.text());
      return null;
    }

    const data = await res.json();
    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      realm_id: "",
      expires_at: expiresAt,
    };
  } catch (err) {
    console.error("[quickbooks] Token refresh error:", (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token Storage
// ---------------------------------------------------------------------------

/**
 * Store QBO tokens in the database.
 */
export async function storeTokens(tokens: QboTokens, userId: string, companyName?: string): Promise<void> {
  if (!process.env.DATABASE_URL) return;

  try {
    await query(
      `INSERT INTO apex_qbo_tokens (realm_id, access_token, refresh_token, expires_at, company_name, connected_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (realm_id) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         expires_at = EXCLUDED.expires_at,
         company_name = COALESCE(EXCLUDED.company_name, apex_qbo_tokens.company_name),
         updated_at = NOW()`,
      [tokens.realm_id, tokens.access_token, tokens.refresh_token, tokens.expires_at, companyName || null, userId],
    );
  } catch (err) {
    console.error("[quickbooks] Failed to store tokens:", (err as Error).message);
  }
}

/**
 * Get a valid (non-expired) access token, auto-refreshing if needed.
 * Returns null if no tokens are stored or refresh fails.
 */
export async function getValidToken(): Promise<{ accessToken: string; realmId: string } | null> {
  if (isShadowMode()) return null;

  const { rows } = await safeQuery<{
    access_token: string;
    refresh_token: string;
    realm_id: string;
    expires_at: string;
    connected_by: string;
  }>(
    `SELECT access_token, refresh_token, realm_id, expires_at, connected_by
     FROM apex_qbo_tokens
     ORDER BY updated_at DESC
     LIMIT 1`,
  );

  if (rows.length === 0) return null;

  const row = rows[0];
  const expiresAt = new Date(row.expires_at).getTime();
  const bufferMs = 5 * 60 * 1000; // refresh 5 min before expiry

  if (Date.now() < expiresAt - bufferMs) {
    return { accessToken: row.access_token, realmId: row.realm_id };
  }

  // Token expired or expiring soon — refresh
  const refreshed = await refreshToken(row.refresh_token);
  if (!refreshed) return null;

  refreshed.realm_id = row.realm_id;
  await storeTokens(refreshed, row.connected_by);

  trackEvent("quickbooks.token_refreshed", row.connected_by, "system", {
    realm_id: row.realm_id,
  });

  return { accessToken: refreshed.access_token, realmId: row.realm_id };
}

/**
 * Delete stored QBO tokens (disconnect).
 */
export async function deleteTokens(): Promise<void> {
  if (!process.env.DATABASE_URL) return;

  try {
    await query(`DELETE FROM apex_qbo_tokens`);
    clearCache();
  } catch (err) {
    console.error("[quickbooks] Failed to delete tokens:", (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// QBO API Wrapper
// ---------------------------------------------------------------------------

/**
 * Make an authenticated request to the QuickBooks Online API.
 */
export async function qboFetch<T = unknown>(
  endpoint: string,
  accessToken: string,
  realmId: string,
): Promise<T | null> {
  const separator = endpoint.includes("?") ? "&" : "?";
  const url = `${QBO_BASE_URL}/company/${realmId}/${endpoint}${separator}minorversion=${QBO_MINOR_VERSION}`;

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    trackEvent("quickbooks.api_called", "system", "system", {
      endpoint,
      realm_id: realmId,
      status: res.status,
    });

    if (!res.ok) {
      console.error(`[quickbooks] API error ${res.status} for ${endpoint}:`, await res.text());
      return null;
    }

    return (await res.json()) as T;
  } catch (err) {
    console.error(`[quickbooks] API fetch error for ${endpoint}:`, (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Connection Status
// ---------------------------------------------------------------------------

/**
 * Get the current QBO connection status.
 */
export async function getConnectionStatus(): Promise<ConnectionStatus> {
  if (isShadowMode()) {
    return {
      connected: true,
      companyName: "Wolfpack Agency LLC",
      realmId: "demo-realm-123",
      lastSync: new Date().toISOString(),
      mode: "shadow",
    };
  }

  const { rows } = await safeQuery<{
    realm_id: string;
    company_name: string | null;
    updated_at: string;
  }>(
    `SELECT realm_id, company_name, updated_at
     FROM apex_qbo_tokens
     ORDER BY updated_at DESC
     LIMIT 1`,
  );

  if (rows.length === 0) {
    return { connected: false, companyName: null, realmId: null, lastSync: null, mode: "live" };
  }

  return {
    connected: true,
    companyName: rows[0].company_name,
    realmId: rows[0].realm_id,
    lastSync: rows[0].updated_at,
    mode: "live",
  };
}

// ---------------------------------------------------------------------------
// Data Fetchers — Live Mode
// ---------------------------------------------------------------------------

async function fetchLiveProfitAndLoss(startDate: string, endDate: string): Promise<ProfitAndLoss | null> {
  const token = await getValidToken();
  if (!token) return null;

  const data = await qboFetch<Record<string, unknown>>(
    `reports/ProfitAndLoss?start_date=${startDate}&end_date=${endDate}`,
    token.accessToken,
    token.realmId,
  );
  if (!data) return null;

  // Parse QBO report format
  try {
    const report = data as { Header?: Record<string, string>; Rows?: { Row?: unknown[] } };
    const rows = report.Rows?.Row as { type?: string; Summary?: { ColData?: { value?: string }[] }; Rows?: { Row?: { ColData?: { value?: string }[] }[] } }[] || [];

    const incomeCategories: { name: string; amount: number }[] = [];
    const expenseCategories: { name: string; amount: number }[] = [];
    let totalIncome = 0;
    let totalExpenses = 0;

    for (const section of rows) {
      if (!section.Rows?.Row) continue;
      const isIncome = section.Summary?.ColData?.[0]?.value?.includes("Income");
      const isExpense = section.Summary?.ColData?.[0]?.value?.includes("Expense");

      for (const row of section.Rows.Row) {
        const name = row.ColData?.[0]?.value || "Other";
        const amount = parseFloat(row.ColData?.[1]?.value || "0");
        if (isIncome) {
          incomeCategories.push({ name, amount });
          totalIncome += amount;
        } else if (isExpense) {
          expenseCategories.push({ name, amount });
          totalExpenses += amount;
        }
      }
    }

    return {
      startDate,
      endDate,
      totalIncome,
      totalExpenses,
      netIncome: totalIncome - totalExpenses,
      incomeCategories,
      expenseCategories,
    };
  } catch {
    console.error("[quickbooks] Failed to parse P&L report");
    return null;
  }
}

async function fetchLiveBalanceSheet(): Promise<BalanceSheet | null> {
  const token = await getValidToken();
  if (!token) return null;

  const data = await qboFetch<Record<string, unknown>>(
    "reports/BalanceSheet",
    token.accessToken,
    token.realmId,
  );
  if (!data) return null;

  try {
    const report = data as { Rows?: { Row?: { type?: string; group?: string; Summary?: { ColData?: { value?: string }[] }; Rows?: { Row?: { ColData?: { value?: string }[] }[] } }[] } };
    const rows = report.Rows?.Row || [];

    const assets: { name: string; amount: number }[] = [];
    const liabilities: { name: string; amount: number }[] = [];
    const equity: { name: string; amount: number }[] = [];
    let totalAssets = 0;
    let totalLiabilities = 0;
    let totalEquity = 0;

    for (const section of rows) {
      const group = section.group || "";
      const target = group.includes("Asset") ? assets : group.includes("Liabilit") ? liabilities : equity;

      if (section.Rows?.Row) {
        for (const row of section.Rows.Row) {
          const name = row.ColData?.[0]?.value || "Other";
          const amount = parseFloat(row.ColData?.[1]?.value || "0");
          target.push({ name, amount });
        }
      }

      const summaryAmt = parseFloat(section.Summary?.ColData?.[1]?.value || "0");
      if (group.includes("Asset")) totalAssets = summaryAmt;
      else if (group.includes("Liabilit")) totalLiabilities = summaryAmt;
      else if (group.includes("Equity")) totalEquity = summaryAmt;
    }

    return {
      asOfDate: new Date().toISOString().split("T")[0],
      totalAssets,
      totalLiabilities,
      totalEquity,
      assets,
      liabilities,
      equity,
    };
  } catch {
    console.error("[quickbooks] Failed to parse Balance Sheet");
    return null;
  }
}

async function fetchLiveCashFlow(startDate: string, endDate: string): Promise<CashFlow | null> {
  const token = await getValidToken();
  if (!token) return null;

  const data = await qboFetch<Record<string, unknown>>(
    `reports/CashFlow?start_date=${startDate}&end_date=${endDate}`,
    token.accessToken,
    token.realmId,
  );
  if (!data) return null;

  try {
    const report = data as { Rows?: { Row?: { Summary?: { ColData?: { value?: string }[] }; group?: string }[] } };
    const rows = report.Rows?.Row || [];

    let operating = 0;
    let investing = 0;
    let financing = 0;

    for (const section of rows) {
      const group = (section.group || "").toLowerCase();
      const amount = parseFloat(section.Summary?.ColData?.[1]?.value || "0");
      if (group.includes("operating")) operating = amount;
      else if (group.includes("investing")) investing = amount;
      else if (group.includes("financing")) financing = amount;
    }

    return {
      startDate,
      endDate,
      operatingActivities: operating,
      investingActivities: investing,
      financingActivities: financing,
      netCashChange: operating + investing + financing,
    };
  } catch {
    console.error("[quickbooks] Failed to parse Cash Flow");
    return null;
  }
}

async function fetchLiveAgedReceivables(): Promise<AgedSummary | null> {
  const token = await getValidToken();
  if (!token) return null;

  const data = await qboFetch<Record<string, unknown>>(
    "reports/AgedReceivableDetail",
    token.accessToken,
    token.realmId,
  );
  if (!data) return null;

  return parseAgedReport(data);
}

async function fetchLiveAgedPayables(): Promise<AgedSummary | null> {
  const token = await getValidToken();
  if (!token) return null;

  const data = await qboFetch<Record<string, unknown>>(
    "reports/AgedPayableDetail",
    token.accessToken,
    token.realmId,
  );
  if (!data) return null;

  return parseAgedReport(data);
}

function parseAgedReport(data: Record<string, unknown>): AgedSummary | null {
  try {
    const report = data as { Rows?: { Row?: { ColData?: { value?: string }[]; type?: string; Rows?: { Row?: { ColData?: { value?: string }[] }[] } }[] } };
    const rows = report.Rows?.Row || [];

    const details: AgedSummary["details"] = [];
    let totalCurrent = 0;
    let total1to30 = 0;
    let total31to60 = 0;
    let total61to90 = 0;
    let totalOver90 = 0;

    for (const section of rows) {
      if (section.type === "Section" && section.Rows?.Row) {
        const name = section.ColData?.[0]?.value || "Unknown";
        const subRows = section.Rows.Row;
        let current = 0, d1 = 0, d31 = 0, d61 = 0, d90 = 0;
        for (const sr of subRows) {
          const cols = sr.ColData || [];
          current += parseFloat(cols[1]?.value || "0");
          d1 += parseFloat(cols[2]?.value || "0");
          d31 += parseFloat(cols[3]?.value || "0");
          d61 += parseFloat(cols[4]?.value || "0");
          d90 += parseFloat(cols[5]?.value || "0");
        }
        details.push({ name, current, days1to30: d1, days31to60: d31, days61to90: d61, over90: d90, total: current + d1 + d31 + d61 + d90 });
        totalCurrent += current;
        total1to30 += d1;
        total31to60 += d31;
        total61to90 += d61;
        totalOver90 += d90;
      }
    }

    return {
      current: totalCurrent,
      days1to30: total1to30,
      days31to60: total31to60,
      days61to90: total61to90,
      over90: totalOver90,
      total: totalCurrent + total1to30 + total31to60 + total61to90 + totalOver90,
      details,
    };
  } catch {
    console.error("[quickbooks] Failed to parse aged report");
    return null;
  }
}

async function fetchLiveUnpaidInvoices(): Promise<Invoice[]> {
  const token = await getValidToken();
  if (!token) return [];

  const data = await qboFetch<{ QueryResponse?: { Invoice?: Record<string, unknown>[] } }>(
    `query?query=${encodeURIComponent("SELECT * FROM Invoice WHERE Balance > '0' ORDERBY DueDate")}`,
    token.accessToken,
    token.realmId,
  );
  if (!data?.QueryResponse?.Invoice) return [];

  return data.QueryResponse.Invoice.map((inv) => ({
    id: String(inv.Id || ""),
    customerName: String((inv.CustomerRef as Record<string, unknown>)?.name || "Unknown"),
    amount: Number(inv.TotalAmt || 0),
    balance: Number(inv.Balance || 0),
    dueDate: String(inv.DueDate || ""),
    status: String(inv.Balance) === String(inv.TotalAmt) ? "Unpaid" : "Partial",
  }));
}

async function fetchLiveRecentPayments(limit: number): Promise<Payment[]> {
  const token = await getValidToken();
  if (!token) return [];

  const data = await qboFetch<{ QueryResponse?: { Payment?: Record<string, unknown>[] } }>(
    `query?query=${encodeURIComponent(`SELECT * FROM Payment ORDERBY TxnDate DESC MAXRESULTS ${limit}`)}`,
    token.accessToken,
    token.realmId,
  );
  if (!data?.QueryResponse?.Payment) return [];

  return data.QueryResponse.Payment.map((pmt) => ({
    id: String(pmt.Id || ""),
    customerName: String((pmt.CustomerRef as Record<string, unknown>)?.name || "Unknown"),
    amount: Number(pmt.TotalAmt || 0),
    date: String(pmt.TxnDate || ""),
    method: String((pmt.PaymentMethodRef as Record<string, unknown>)?.name || "Other"),
  }));
}

async function fetchLiveCompanyInfo(): Promise<CompanyInfo | null> {
  const token = await getValidToken();
  if (!token) return null;

  const data = await qboFetch<{ CompanyInfo?: Record<string, unknown> }>(
    "companyinfo/" + token.realmId,
    token.accessToken,
    token.realmId,
  );
  if (!data?.CompanyInfo) return null;

  const info = data.CompanyInfo;
  return {
    companyName: String(info.CompanyName || ""),
    legalName: String(info.LegalName || ""),
    fiscalYearStart: String(info.FiscalYearStartMonth || "January"),
    country: String(info.Country || "US"),
    email: String((info.Email as Record<string, unknown>)?.Address || ""),
    phone: String((info.PrimaryPhone as Record<string, unknown>)?.FreeFormNumber || ""),
  };
}

// ---------------------------------------------------------------------------
// Shadow Mode Demo Data (realistic 5-person marketing/tech agency)
// ---------------------------------------------------------------------------

function demoCompanyInfo(): CompanyInfo {
  return {
    companyName: "Wolfpack Agency LLC",
    legalName: "Wolfpack Agency LLC",
    fiscalYearStart: "January",
    country: "US",
    email: "accounting@wolfpack.dev",
    phone: "(555) 867-5309",
  };
}

function demoProfitAndLoss(startDate: string, endDate: string): ProfitAndLoss {
  return {
    startDate,
    endDate,
    totalIncome: 52_340,
    totalExpenses: 31_870,
    netIncome: 20_470,
    incomeCategories: [
      { name: "Web Development Services", amount: 24_500 },
      { name: "AI/ML Consulting", amount: 14_200 },
      { name: "Retainer Agreements", amount: 8_500 },
      { name: "Design & Branding", amount: 3_640 },
      { name: "Hosting & Maintenance", amount: 1_500 },
    ],
    expenseCategories: [
      { name: "Payroll & Contractors", amount: 18_200 },
      { name: "Cloud Infrastructure (AWS/Vercel)", amount: 3_450 },
      { name: "Software Subscriptions", amount: 2_890 },
      { name: "Office & Coworking", amount: 2_100 },
      { name: "Marketing & Advertising", amount: 1_980 },
      { name: "Insurance (E&O + GL)", amount: 850 },
      { name: "Professional Development", amount: 1_200 },
      { name: "Legal & Accounting", amount: 1_200 },
    ],
  };
}

function demoBalanceSheet(): BalanceSheet {
  return {
    asOfDate: new Date().toISOString().split("T")[0],
    totalAssets: 187_640,
    totalLiabilities: 34_200,
    totalEquity: 153_440,
    assets: [
      { name: "Business Checking (Mercury)", amount: 94_320 },
      { name: "Business Savings", amount: 45_000 },
      { name: "Accounts Receivable", amount: 38_750 },
      { name: "Prepaid Expenses", amount: 4_200 },
      { name: "Equipment (net)", amount: 5_370 },
    ],
    liabilities: [
      { name: "Accounts Payable", amount: 8_900 },
      { name: "Credit Card (Amex)", amount: 4_300 },
      { name: "Payroll Liabilities", amount: 6_200 },
      { name: "Deferred Revenue", amount: 12_000 },
      { name: "State Tax Payable", amount: 2_800 },
    ],
    equity: [
      { name: "Owner's Equity", amount: 100_000 },
      { name: "Retained Earnings", amount: 32_970 },
      { name: "Current Year Net Income", amount: 20_470 },
    ],
  };
}

function demoCashFlow(startDate: string, endDate: string): CashFlow {
  return {
    startDate,
    endDate,
    operatingActivities: 18_320,
    investingActivities: -2_400,
    financingActivities: -5_000,
    netCashChange: 10_920,
  };
}

function demoAgedReceivables(): AgedSummary {
  return {
    current: 18_500,
    days1to30: 12_250,
    days31to60: 5_500,
    days61to90: 2_000,
    over90: 500,
    total: 38_750,
    details: [
      { name: "Greenfield Corp", current: 8_500, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0, total: 8_500 },
      { name: "Horizon Digital", current: 4_200, days1to30: 6_000, days31to60: 0, days61to90: 0, over90: 0, total: 10_200 },
      { name: "Apex Ventures", current: 3_800, days1to30: 3_250, days31to60: 2_500, days61to90: 0, over90: 0, total: 9_550 },
      { name: "Bloom & Co", current: 2_000, days1to30: 3_000, days31to60: 3_000, days61to90: 0, over90: 0, total: 8_000 },
      { name: "Redline Studios", current: 0, days1to30: 0, days31to60: 0, days61to90: 2_000, over90: 500, total: 2_500 },
    ],
  };
}

function demoAgedPayables(): AgedSummary {
  return {
    current: 5_400,
    days1to30: 2_800,
    days31to60: 700,
    days61to90: 0,
    over90: 0,
    total: 8_900,
    details: [
      { name: "AWS", current: 2_100, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0, total: 2_100 },
      { name: "Vercel Inc", current: 680, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0, total: 680 },
      { name: "Figma", current: 420, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0, total: 420 },
      { name: "WeWork (Coworking)", current: 2_200, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0, total: 2_200 },
      { name: "Contractor — Sarah K.", current: 0, days1to30: 2_800, days31to60: 700, days61to90: 0, over90: 0, total: 3_500 },
    ],
  };
}

function demoUnpaidInvoices(): Invoice[] {
  const today = new Date();
  return [
    { id: "INV-1047", customerName: "Greenfield Corp", amount: 8_500, balance: 8_500, dueDate: futureDate(today, 14), status: "Unpaid" },
    { id: "INV-1044", customerName: "Horizon Digital", amount: 6_000, balance: 6_000, dueDate: futureDate(today, 3), status: "Unpaid" },
    { id: "INV-1042", customerName: "Apex Ventures", amount: 5_750, balance: 3_250, dueDate: pastDate(today, 5), status: "Partial" },
    { id: "INV-1039", customerName: "Bloom & Co", amount: 4_200, balance: 4_200, dueDate: pastDate(today, 12), status: "Unpaid" },
    { id: "INV-1041", customerName: "Horizon Digital", amount: 4_200, balance: 4_200, dueDate: futureDate(today, 7), status: "Unpaid" },
    { id: "INV-1038", customerName: "Apex Ventures", amount: 3_800, balance: 3_800, dueDate: futureDate(today, 21), status: "Unpaid" },
    { id: "INV-1035", customerName: "Redline Studios", amount: 2_500, balance: 2_500, dueDate: pastDate(today, 45), status: "Unpaid" },
    { id: "INV-1046", customerName: "Bloom & Co", amount: 2_000, balance: 2_000, dueDate: futureDate(today, 10), status: "Unpaid" },
  ];
}

function demoRecentPayments(limit: number): Payment[] {
  const today = new Date();
  const all: Payment[] = [
    { id: "PMT-892", customerName: "Greenfield Corp", amount: 12_000, date: pastDate(today, 2), method: "ACH" },
    { id: "PMT-891", customerName: "Apex Ventures", amount: 2_500, date: pastDate(today, 4), method: "Credit Card" },
    { id: "PMT-890", customerName: "Horizon Digital", amount: 8_400, date: pastDate(today, 7), method: "ACH" },
    { id: "PMT-889", customerName: "Bloom & Co", amount: 3_600, date: pastDate(today, 10), method: "Check" },
    { id: "PMT-888", customerName: "Greenfield Corp", amount: 6_500, date: pastDate(today, 15), method: "ACH" },
    { id: "PMT-887", customerName: "Redline Studios", amount: 4_000, date: pastDate(today, 18), method: "Wire" },
    { id: "PMT-886", customerName: "Apex Ventures", amount: 7_200, date: pastDate(today, 22), method: "ACH" },
    { id: "PMT-885", customerName: "Bloom & Co", amount: 2_800, date: pastDate(today, 25), method: "Credit Card" },
  ];
  return all.slice(0, limit);
}

function futureDate(from: Date, days: number): string {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function pastDate(from: Date, days: number): string {
  const d = new Date(from);
  d.setDate(d.getDate() - days);
  return d.toISOString().split("T")[0];
}

// ---------------------------------------------------------------------------
// Public Fetchers (cached, shadow-aware)
// ---------------------------------------------------------------------------

/**
 * Fetch Profit & Loss report for the given date range.
 */
export async function fetchProfitAndLoss(startDate: string, endDate: string): Promise<ProfitAndLoss | null> {
  const cacheKey = `pnl:${startDate}:${endDate}`;
  const cached = getCached<ProfitAndLoss>(cacheKey);
  if (cached) return cached;

  const result = isShadowMode()
    ? demoProfitAndLoss(startDate, endDate)
    : await fetchLiveProfitAndLoss(startDate, endDate);

  if (result) setCache(cacheKey, result);
  return result;
}

/**
 * Fetch the current Balance Sheet.
 */
export async function fetchBalanceSheet(): Promise<BalanceSheet | null> {
  const cacheKey = "balance-sheet";
  const cached = getCached<BalanceSheet>(cacheKey);
  if (cached) return cached;

  const result = isShadowMode() ? demoBalanceSheet() : await fetchLiveBalanceSheet();
  if (result) setCache(cacheKey, result);
  return result;
}

/**
 * Fetch Cash Flow statement for the given date range.
 */
export async function fetchCashFlow(startDate: string, endDate: string): Promise<CashFlow | null> {
  const cacheKey = `cashflow:${startDate}:${endDate}`;
  const cached = getCached<CashFlow>(cacheKey);
  if (cached) return cached;

  const result = isShadowMode()
    ? demoCashFlow(startDate, endDate)
    : await fetchLiveCashFlow(startDate, endDate);

  if (result) setCache(cacheKey, result);
  return result;
}

/**
 * Fetch Aged Receivables (AR aging) summary.
 */
export async function fetchAgedReceivables(): Promise<AgedSummary | null> {
  const cacheKey = "aged-receivables";
  const cached = getCached<AgedSummary>(cacheKey);
  if (cached) return cached;

  const result = isShadowMode() ? demoAgedReceivables() : await fetchLiveAgedReceivables();
  if (result) setCache(cacheKey, result);
  return result;
}

/**
 * Fetch Aged Payables (AP aging) summary.
 */
export async function fetchAgedPayables(): Promise<AgedSummary | null> {
  const cacheKey = "aged-payables";
  const cached = getCached<AgedSummary>(cacheKey);
  if (cached) return cached;

  const result = isShadowMode() ? demoAgedPayables() : await fetchLiveAgedPayables();
  if (result) setCache(cacheKey, result);
  return result;
}

/**
 * Fetch unpaid/open invoices with customer, amount, and due date.
 */
export async function fetchUnpaidInvoices(): Promise<Invoice[]> {
  const cacheKey = "unpaid-invoices";
  const cached = getCached<Invoice[]>(cacheKey);
  if (cached) return cached;

  const result = isShadowMode() ? demoUnpaidInvoices() : await fetchLiveUnpaidInvoices();
  setCache(cacheKey, result);
  return result;
}

/**
 * Fetch recent payments received.
 */
export async function fetchRecentPayments(limit: number = 10): Promise<Payment[]> {
  const cacheKey = `recent-payments:${limit}`;
  const cached = getCached<Payment[]>(cacheKey);
  if (cached) return cached;

  const result = isShadowMode() ? demoRecentPayments(limit) : await fetchLiveRecentPayments(limit);
  setCache(cacheKey, result);
  return result;
}

/**
 * Fetch company information from QBO.
 */
export async function fetchCompanyInfo(): Promise<CompanyInfo | null> {
  const cacheKey = "company-info";
  const cached = getCached<CompanyInfo>(cacheKey);
  if (cached) return cached;

  const result = isShadowMode() ? demoCompanyInfo() : await fetchLiveCompanyInfo();
  if (result) setCache(cacheKey, result);
  return result;
}
