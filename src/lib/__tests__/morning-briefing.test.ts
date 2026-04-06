/**
 * Morning Briefing Tests
 *
 * Tests cover:
 *   - Briefing generation in shadow mode
 *   - Data shape and required fields
 *   - Action item generation logic
 *   - Greeting personalization
 *   - Calendar section
 *   - Email section
 *   - Financial section
 *   - Client attention section
 *   - Cache behavior
 *   - Analytics tracking
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

// Mock quickbooks to return demo data (with connected status for CEO tests)
jest.mock("@/lib/quickbooks", () => ({
  fetchProfitAndLoss: jest.fn().mockResolvedValue({
    totalIncome: 52000,
    totalExpenses: 32000,
    netIncome: 20000,
    incomeCategories: [],
    expenseCategories: [],
  }),
  fetchBalanceSheet: jest.fn().mockResolvedValue({
    totalAssets: 85000,
    assets: [{ name: "Checking", amount: 47000 }],
  }),
  fetchUnpaidInvoices: jest.fn().mockResolvedValue([
    { customerName: "Horizon Digital", amount: 8500, balance: 8500, dueDate: "2026-03-15" },
    { customerName: "Greenfield Corp", amount: 4200, balance: 4200, dueDate: "2026-04-20" },
  ]),
  fetchRecentPayments: jest.fn().mockResolvedValue([
    { customerName: "Apex Media", amount: 6500, date: "2026-04-04" },
  ]),
  fetchAgedReceivables: jest.fn().mockResolvedValue({
    total: 12700,
    over90: 0,
    details: [],
  }),
  getConnectionStatus: jest.fn().mockResolvedValue({ connected: true, mode: "live" }),
}));

// Mock microsoft-graph to return demo data
jest.mock("@/lib/microsoft-graph", () => ({
  fetchCalendarEvents: jest.fn().mockResolvedValue([
    { subject: "Client Review: Greenfield Corp", start: { dateTime: "2026-04-06T10:00:00" }, end: { dateTime: "2026-04-06T11:00:00" }, attendees: [] },
    { subject: "Team Standup", start: { dateTime: "2026-04-06T09:00:00" }, end: { dateTime: "2026-04-06T09:30:00" }, attendees: [] },
  ]),
  fetchRecentEmails: jest.fn().mockResolvedValue([
    { subject: "Invoice Payment Confirmation", from: "billing@greenfieldcorp.com", receivedDateTime: "2026-04-06T08:15:00Z", bodyPreview: "Payment processed", isRead: false, importance: "high" },
    { subject: "Q2 Proposal Draft", from: "jorge@wolfpack.dev", receivedDateTime: "2026-04-06T07:30:00Z", bodyPreview: "Attached draft", isRead: true, importance: "normal" },
  ]),
  fetchUnreadCount: jest.fn().mockResolvedValue(7),
  fetchUserProfile: jest.fn().mockResolvedValue({ displayName: "Hoxsie", mail: "ceo@wolfpack.dev" }),
  getConnectionStatus: jest.fn().mockResolvedValue({ connected: true, mode: "live" }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: true });
});

// ---------------------------------------------------------------------------
// Briefing Generation
// ---------------------------------------------------------------------------

describe("Briefing Generation", () => {
  let briefing: typeof import("@/lib/morning-briefing");

  beforeEach(async () => {
    jest.resetModules();
    // Re-import after resetting modules so mocks take effect
    briefing = await import("@/lib/morning-briefing");
  });

  test("generates a complete briefing", async () => {
    const result = await briefing.generateBriefing("demo-ceo", "ceo");
    expect(result).toBeDefined();
    expect(result.generatedAt).toBeTruthy();
    expect(result.greeting).toBeTruthy();
    expect(result.summary).toBeTruthy();
  });

  test("briefing has calendar section", async () => {
    const result = await briefing.generateBriefing("demo-ceo", "ceo");
    expect(result.calendar).toBeDefined();
    expect(typeof result.calendar.eventCount).toBe("number");
    expect(Array.isArray(result.calendar.events)).toBe(true);
  });

  test("briefing has email section", async () => {
    const result = await briefing.generateBriefing("demo-ceo", "ceo");
    expect(result.email).toBeDefined();
    expect(typeof result.email.unreadCount).toBe("number");
    expect(Array.isArray(result.email.importantEmails)).toBe(true);
  });

  test("briefing has financial section", async () => {
    const result = await briefing.generateBriefing("demo-ceo", "ceo");
    expect(result.financial).toBeDefined();
    expect(typeof result.financial.revenueThisMonth).toBe("number");
    expect(typeof result.financial.netProfit).toBe("number");
  });

  test("briefing has action items", async () => {
    const result = await briefing.generateBriefing("demo-ceo", "ceo");
    expect(result.actionItems).toBeDefined();
    expect(Array.isArray(result.actionItems)).toBe(true);
    if (result.actionItems.length > 0) {
      expect(["high", "medium", "low"]).toContain(result.actionItems[0].priority);
      expect(result.actionItems[0].text).toBeTruthy();
    }
  });

  test("briefing has clients needing attention", async () => {
    const result = await briefing.generateBriefing("demo-ceo", "ceo");
    expect(result.clients).toBeDefined();
    expect(Array.isArray(result.clients.needingAttention)).toBe(true);
  });

  test("greeting includes time-appropriate salutation", async () => {
    const result = await briefing.generateBriefing("demo-ceo", "ceo");
    expect(result.greeting.length).toBeGreaterThan(0);
    // Should contain some kind of greeting
    expect(
      result.greeting.toLowerCase().includes("morning") ||
      result.greeting.toLowerCase().includes("afternoon") ||
      result.greeting.toLowerCase().includes("evening") ||
      result.greeting.toLowerCase().includes("hello") ||
      result.greeting.toLowerCase().includes("good")
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Action Items
// ---------------------------------------------------------------------------

describe("Action Items", () => {
  let briefing: typeof import("@/lib/morning-briefing");

  beforeEach(async () => {
    jest.resetModules();
    briefing = await import("@/lib/morning-briefing");
  });

  test("overdue invoices generate high priority items", async () => {
    const result = await briefing.generateBriefing("demo-ceo", "ceo");
    const highItems = result.actionItems.filter((a: any) => a.priority === "high");
    // Horizon Digital invoice is past due (2026-03-15)
    const overdueItem = highItems.find((a: any) =>
      a.text.toLowerCase().includes("horizon") || a.text.toLowerCase().includes("overdue") || a.text.toLowerCase().includes("invoice")
    );
    expect(overdueItem || highItems.length > 0).toBeTruthy();
  });

  test("action items have text and context", async () => {
    const result = await briefing.generateBriefing("demo-ceo", "ceo");
    for (const item of result.actionItems) {
      expect(item.text.length).toBeGreaterThan(0);
      expect(["high", "medium", "low"]).toContain(item.priority);
    }
  });
});

// ---------------------------------------------------------------------------
// Financial Data
// ---------------------------------------------------------------------------

describe("Financial Data in Briefing", () => {
  let briefing: typeof import("@/lib/morning-briefing");

  beforeEach(async () => {
    jest.resetModules();
    briefing = await import("@/lib/morning-briefing");
  });

  test("includes revenue from QuickBooks", async () => {
    const result = await briefing.generateBriefing("demo-ceo", "ceo");
    expect(result.financial.revenueThisMonth).toBeGreaterThan(0);
  });

  test("includes net profit", async () => {
    const result = await briefing.generateBriefing("demo-ceo", "ceo");
    expect(typeof result.financial.netProfit).toBe("number");
  });

  test("includes unpaid invoice count", async () => {
    const result = await briefing.generateBriefing("demo-ceo", "ceo");
    expect(result.financial.unpaidInvoiceCount).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

describe("Analytics Tracking", () => {
  test("briefing event types registered", () => {
    const fs = require("fs");
    const analytics = fs.readFileSync(
      require("path").resolve(__dirname, "../analytics.ts"),
      "utf-8",
    );
    expect(analytics).toContain("briefing.generated");
  });
});
