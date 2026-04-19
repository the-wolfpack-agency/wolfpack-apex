/**
 * QuickBooks Integration Tests
 *
 * Tests cover:
 *   - OAuth2 URL generation
 *   - Shadow mode demo data for all fetchers
 *   - Data types and shapes
 *   - Demo data quality (realistic agency numbers)
 *   - Error handling (returns null, not throws)
 *   - Migration file exists and has correct schema
 *   - Analytics event types registered
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockTrackEvent = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackEvent(...args),
}));

jest.mock("@/lib/db", () => ({
  query: jest.fn(),
  safeQuery: (...args: any[]) => mockSafeQuery(...args),
  pool: { query: jest.fn() },
}));

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.QBO_CLIENT_ID;
  delete process.env.QBO_CLIENT_SECRET;
  delete process.env.QBO_REDIRECT_URI;
  delete process.env.QBO_REALM_ID;
});

// ---------------------------------------------------------------------------
// Shadow Mode
// ---------------------------------------------------------------------------

describe("Shadow Mode (no QBO credentials)", () => {
  let qb: typeof import("@/lib/quickbooks");

  beforeEach(async () => {
    jest.resetModules();
    delete process.env.QBO_CLIENT_ID;
    qb = await import("@/lib/quickbooks");
  });

  test("getAuthUrl returns empty string in shadow mode", () => {
    const url = qb.getAuthUrl();
    expect(url === "" || url === null).toBe(true);
  });

  test("fetchProfitAndLoss returns demo data", async () => {
    const result = await qb.fetchProfitAndLoss("2026-01-01", "2026-01-31");
    expect(result).not.toBeNull();
    expect(result!.totalIncome).toBeGreaterThan(0);
    expect(result!.totalExpenses).toBeGreaterThan(0);
    expect(typeof result!.netIncome).toBe("number");
  });

  test("fetchBalanceSheet returns demo data", async () => {
    const result = await qb.fetchBalanceSheet();
    expect(result).not.toBeNull();
    expect(result!.totalAssets).toBeGreaterThan(0);
    expect(typeof result!.totalLiabilities).toBe("number");
    expect(typeof result!.totalEquity).toBe("number");
  });

  test("fetchCashFlow returns demo data", async () => {
    const result = await qb.fetchCashFlow("2026-01-01", "2026-01-31");
    expect(result).not.toBeNull();
    expect(typeof result!.operatingActivities).toBe("number");
    expect(typeof result!.netCashChange).toBe("number");
  });

  test("fetchAgedReceivables returns demo data", async () => {
    const result = await qb.fetchAgedReceivables();
    expect(result).not.toBeNull();
    expect(typeof result!.total).toBe("number");
    expect(typeof result!.current).toBe("number");
    expect(Array.isArray(result!.details)).toBe(true);
  });

  test("fetchAgedPayables returns demo data", async () => {
    const result = await qb.fetchAgedPayables();
    expect(result).not.toBeNull();
    expect(typeof result!.total).toBe("number");
    expect(Array.isArray(result!.details)).toBe(true);
  });

  test("fetchUnpaidInvoices returns demo data", async () => {
    const result = await qb.fetchUnpaidInvoices();
    expect(Array.isArray(result)).toBe(true);
    if (result.length > 0) {
      expect(result[0]).toHaveProperty("customerName");
      expect(result[0]).toHaveProperty("amount");
      expect(result[0]).toHaveProperty("dueDate");
      expect(result[0]).toHaveProperty("balance");
    }
  });

  test("fetchRecentPayments returns demo data", async () => {
    const result = await qb.fetchRecentPayments(5);
    expect(Array.isArray(result)).toBe(true);
    if (result.length > 0) {
      expect(result[0]).toHaveProperty("customerName");
      expect(result[0]).toHaveProperty("amount");
      expect(result[0]).toHaveProperty("date");
    }
  });

  test("fetchCompanyInfo returns demo data", async () => {
    const result = await qb.fetchCompanyInfo();
    expect(result).not.toBeNull();
    expect(result!.companyName).toBeTruthy();
  });

  test("getConnectionStatus returns shadow mode", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: true });
    const status = await qb.getConnectionStatus();
    expect(status.mode).toBe("shadow");
  });
});

// ---------------------------------------------------------------------------
// OAuth2
// ---------------------------------------------------------------------------

describe("OAuth2 URL Generation", () => {
  let qb: typeof import("@/lib/quickbooks");

  beforeEach(async () => {
    jest.resetModules();
    process.env.QBO_CLIENT_ID = "test-client-id";
    process.env.QBO_CLIENT_SECRET = "test-secret";
    process.env.QBO_REDIRECT_URI = "https://wolfpack-instinct.vercel.app/api/quickbooks/callback";
    qb = await import("@/lib/quickbooks");
  });

  test("generates auth URL containing client ID", () => {
    const url = qb.getAuthUrl();
    expect(url).toContain("test-client-id");
  });

  test("auth URL targets Intuit", () => {
    const url = qb.getAuthUrl();
    expect(url).toContain("intuit.com");
  });

  test("auth URL includes accounting scope", () => {
    const url = qb.getAuthUrl();
    expect(url).toContain("com.intuit.quickbooks.accounting");
  });

  test("auth URL includes redirect URI", () => {
    const url = qb.getAuthUrl();
    expect(url).toContain("callback");
  });
});

// ---------------------------------------------------------------------------
// Demo Data Quality
// ---------------------------------------------------------------------------

describe("Demo Data Quality", () => {
  let qb: typeof import("@/lib/quickbooks");

  beforeEach(async () => {
    jest.resetModules();
    delete process.env.QBO_CLIENT_ID;
    qb = await import("@/lib/quickbooks");
  });

  test("P&L has realistic agency numbers", async () => {
    const pnl = await qb.fetchProfitAndLoss("2026-01-01", "2026-12-31");
    expect(pnl).not.toBeNull();
    expect(pnl!.totalIncome).toBeGreaterThan(10000);
    expect(pnl!.totalIncome).toBeLessThan(500000);
    expect(pnl!.totalExpenses).toBeGreaterThan(0);
  });

  test("Balance sheet has positive assets", async () => {
    const bs = await qb.fetchBalanceSheet();
    expect(bs).not.toBeNull();
    expect(bs!.totalAssets).toBeGreaterThan(0);
  });

  test("Unpaid invoices have customer names and amounts", async () => {
    const invoices = await qb.fetchUnpaidInvoices();
    for (const inv of invoices) {
      expect(inv.customerName).toBeTruthy();
      expect(inv.amount).toBeGreaterThan(0);
      expect(inv.dueDate).toBeTruthy();
    }
  });

  test("Recent payments have positive amounts", async () => {
    const payments = await qb.fetchRecentPayments(5);
    for (const p of payments) {
      expect(p.amount).toBeGreaterThan(0);
      expect(p.customerName).toBeTruthy();
    }
  });

  test("P&L has income and expense categories", async () => {
    const pnl = await qb.fetchProfitAndLoss("2026-01-01", "2026-12-31");
    expect(pnl).not.toBeNull();
    expect(Array.isArray(pnl!.incomeCategories)).toBe(true);
    expect(Array.isArray(pnl!.expenseCategories)).toBe(true);
    expect(pnl!.incomeCategories.length).toBeGreaterThan(0);
    expect(pnl!.expenseCategories.length).toBeGreaterThan(0);
  });

  test("Balance sheet has asset and liability breakdowns", async () => {
    const bs = await qb.fetchBalanceSheet();
    expect(bs).not.toBeNull();
    expect(Array.isArray(bs!.assets)).toBe(true);
    expect(Array.isArray(bs!.liabilities)).toBe(true);
  });

  test("AR aging has detail rows", async () => {
    const ar = await qb.fetchAgedReceivables();
    expect(ar).not.toBeNull();
    expect(ar!.details.length).toBeGreaterThan(0);
    for (const row of ar!.details) {
      expect(row.name).toBeTruthy();
      expect(typeof row.total).toBe("number");
    }
  });

  test("Company info has name", async () => {
    const info = await qb.fetchCompanyInfo();
    expect(info).not.toBeNull();
    expect(info!.companyName.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Error Handling
// ---------------------------------------------------------------------------

describe("Error Handling", () => {
  let qb: typeof import("@/lib/quickbooks");

  beforeEach(async () => {
    jest.resetModules();
    process.env.QBO_CLIENT_ID = "test-client-id";
    process.env.QBO_CLIENT_SECRET = "test-secret";
    qb = await import("@/lib/quickbooks");
  });

  test("exchangeCode returns null on API failure", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "invalid_grant",
    });
    global.fetch = mockFetch;

    const result = await qb.exchangeCode("bad-code", "realm");
    expect(result).toBeNull();
  });

  test("refreshToken returns null on expired token", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "invalid_grant",
    });
    global.fetch = mockFetch;

    const result = await qb.refreshToken("expired-token");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

describe("Cache", () => {
  let qb: typeof import("@/lib/quickbooks");

  beforeEach(async () => {
    jest.resetModules();
    delete process.env.QBO_CLIENT_ID;
    qb = await import("@/lib/quickbooks");
  });

  test("clearCache function exists and runs without error", () => {
    expect(() => qb.clearCache()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

describe("Migration File", () => {
  test("migration 004 exists", () => {
    const fs = require("fs");
    const p = require("path").resolve(__dirname, "../../db/migrations/004_quickbooks.sql");
    expect(fs.existsSync(p)).toBe(true);
  });

  test("migration 004 creates the original apex_qbo_tokens table (historical)", () => {
    const fs = require("fs");
    const sql = fs.readFileSync(
      require("path").resolve(__dirname, "../../db/migrations/004_quickbooks.sql"),
      "utf-8",
    );
    // Historical migration — MUST keep the original apex_ name; it is
    // renamed by migration 042. Do not rewrite landed migrations.
    expect(sql).toContain("apex_qbo_tokens");
    expect(sql).toContain("realm_id");
    expect(sql).toContain("access_token");
    expect(sql).toContain("refresh_token");
    expect(sql).toContain("expires_at");
  });

  test("migration 042 renames apex_qbo_tokens → instinct_qbo_tokens with compat view", () => {
    const fs = require("fs");
    const sql = fs.readFileSync(
      require("path").resolve(__dirname, "../../db/migrations/042_rename_qbo_tokens.sql"),
      "utf-8",
    );
    // Defensive rename (Case B): ALTER TABLE ... RENAME TO
    expect(sql).toMatch(/ALTER TABLE apex_qbo_tokens RENAME TO instinct_qbo_tokens/);
    // Backward-compat view so any missed code reference still works.
    expect(sql).toMatch(/CREATE OR REPLACE VIEW apex_qbo_tokens AS SELECT \* FROM instinct_qbo_tokens/);
    // Row-count assertion present.
    expect(sql).toContain("Row-count mismatch after rename");
    // Index rename aligned with instinct_* convention.
    expect(sql).toMatch(/ALTER INDEX IF EXISTS idx_qbo_tokens_realm RENAME TO idx_instinct_qbo_tokens_realm/);
  });

  test("migration 042 has a reversible .down.sql", () => {
    const fs = require("fs");
    const down = fs.readFileSync(
      require("path").resolve(__dirname, "../../db/migrations/042_rename_qbo_tokens.down.sql"),
      "utf-8",
    );
    expect(down).toMatch(/ALTER TABLE IF EXISTS instinct_qbo_tokens RENAME TO apex_qbo_tokens/);
    expect(down).toMatch(/CREATE OR REPLACE VIEW instinct_qbo_tokens AS/);
    expect(down).toMatch(/ALTER INDEX IF EXISTS idx_instinct_qbo_tokens_realm RENAME TO idx_qbo_tokens_realm/);
  });
});

// ---------------------------------------------------------------------------
// Analytics Event Types
// ---------------------------------------------------------------------------

describe("Analytics Event Types", () => {
  test("QuickBooks event types are registered", () => {
    const fs = require("fs");
    const analytics = fs.readFileSync(
      require("path").resolve(__dirname, "../analytics.ts"),
      "utf-8",
    );
    expect(analytics).toContain("quickbooks.api_called");
    expect(analytics).toContain("quickbooks.connected");
    expect(analytics).toContain("quickbooks.disconnected");
    expect(analytics).toContain("quickbooks.token_refreshed");
    expect(analytics).toContain("quickbooks.sync_completed");
  });
});
export {};
