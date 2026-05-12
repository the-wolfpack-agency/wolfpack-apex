/**
 * Setup Funnel Helper Tests
 *
 * Covers:
 *   - Happy path: returns funnel rows from the view
 *   - Shadow mode: returns empty array when DATABASE_URL is not set
 */

 

const mockSafeQuery = jest.fn();

jest.mock("@/lib/db", () => ({
  query: jest.fn(),
  safeQuery: (...args: any[]) => mockSafeQuery(...args),
}));

const origEnv = process.env;

describe("getSetupFunnel", () => {
  beforeEach(() => {
    jest.resetModules();
    mockSafeQuery.mockReset();
    process.env = { ...origEnv, DATABASE_URL: "postgres://localhost/test" };
  });

  afterAll(() => {
    process.env = origEnv;
  });

  it("returns funnel rows on happy path", async () => {
    const fakeRows = [
      { step: "profile",      viewed_count: 50, completed_count: 45, abandoned_count: 5,  completion_rate: 0.9,  median_duration_ms: 3200 },
      { step: "team",         viewed_count: 45, completed_count: 38, abandoned_count: 7,  completion_rate: 0.84, median_duration_ms: 5100 },
      { step: "integrations", viewed_count: 38, completed_count: 30, abandoned_count: 8,  completion_rate: 0.79, median_duration_ms: 8400 },
    ];
    mockSafeQuery.mockResolvedValue({ rows: fakeRows, fromCache: false });

    const { getSetupFunnel } = require("@/lib/setup-funnel");
    const result = await getSetupFunnel();

    expect(result).toHaveLength(3);
    expect(result[0].step).toBe("profile");
    expect(result[0].viewed_count).toBe(50);
    expect(result[0].completion_rate).toBe(0.9);
    expect(mockSafeQuery).toHaveBeenCalledWith(
      expect.stringContaining("instinct_setup_funnel"),
    );
  });

  it("returns empty array in shadow mode (no DATABASE_URL)", async () => {
    delete process.env.DATABASE_URL;
    const { getSetupFunnel } = require("@/lib/setup-funnel");
    const result = await getSetupFunnel();

    expect(result).toEqual([]);
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });

  it("returns empty array when safeQuery returns fromCache=true (DB unreachable)", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: true });
    const { getSetupFunnel } = require("@/lib/setup-funnel");
    const result = await getSetupFunnel();

    expect(result).toEqual([]);
  });

  it("returns correct FunnelRow shape", async () => {
    const fakeRow = {
      step: "profile",
      viewed_count: 10,
      completed_count: 8,
      abandoned_count: 2,
      completion_rate: 0.8,
      median_duration_ms: null,
    };
    mockSafeQuery.mockResolvedValue({ rows: [fakeRow], fromCache: false });

    const { getSetupFunnel } = require("@/lib/setup-funnel");
    const result = await getSetupFunnel();

    expect(result[0]).toMatchObject({
      step: expect.any(String),
      viewed_count: expect.any(Number),
      completed_count: expect.any(Number),
      abandoned_count: expect.any(Number),
      completion_rate: expect.any(Number),
    });
    expect(result[0].median_duration_ms).toBeNull();
  });
});

export {};
