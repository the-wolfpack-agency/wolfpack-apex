/**
 * Microsoft People integration tests — suggest with/without query, cache
 * hit, 403 handling.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

const mockTrackPeople = jest.fn();
const mockQueryPeople = jest.fn();
const mockSafeQueryPeople = jest.fn();
const mockGetValidTokenPeople = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackPeople(...args),
}));
jest.mock("@/lib/db", () => ({
  query: (...args: any[]) => mockQueryPeople(...args),
  safeQuery: (...args: any[]) => mockSafeQueryPeople(...args),
  pool: { query: jest.fn() },
}));
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...args: any[]) => mockGetValidTokenPeople(...args),
}));

const realFetchPeople = global.fetch;
const fetchMockPeople = jest.fn();

beforeAll(() => { (global as any).fetch = fetchMockPeople; });
afterAll(() => { (global as any).fetch = realFetchPeople; });

beforeEach(() => {
  jest.clearAllMocks();
  fetchMockPeople.mockReset();
  mockGetValidTokenPeople.mockResolvedValue({ accessToken: "tok" });
  mockSafeQueryPeople.mockResolvedValue({ rows: [] });
  mockQueryPeople.mockResolvedValue({ rows: [] });
  process.env.DATABASE_URL = "postgres://test";
});

function okRespPpl(data: unknown): any {
  return { ok: true, status: 200, json: () => Promise.resolve(data), headers: { get: () => null }, text: () => Promise.resolve("") };
}
function errRespPpl(status: number): any {
  return { ok: false, status, headers: { get: () => null }, json: () => Promise.resolve({}), text: () => Promise.resolve("") };
}

describe("suggestPeople", () => {
  it("hits Graph without search param when query is empty", async () => {
    fetchMockPeople.mockResolvedValueOnce(okRespPpl({
      value: [
        { id: "p1", displayName: "Alice", scoredEmailAddresses: [{ address: "a@x", relevanceScore: 0.9 }], personType: { class: "Person" } },
      ],
    }));
    const { suggestPeople } = await import("@/lib/integrations/microsoft-people");
    const out = await suggestPeople("u-1");
    expect(out[0].email).toBe("a@x");
    expect(fetchMockPeople.mock.calls[0][0]).not.toContain("%24search");
    expect(mockTrackPeople).toHaveBeenCalledWith(
      "system.ms_people_suggestions_fetched",
      "u-1",
      "system",
      expect.objectContaining({ from_cache: false, count: 1 }),
    );
  });

  it("adds $search when query present", async () => {
    fetchMockPeople.mockResolvedValueOnce(okRespPpl({ value: [] }));
    const { suggestPeople } = await import("@/lib/integrations/microsoft-people");
    await suggestPeople("u-1", "nick");
    expect(fetchMockPeople.mock.calls[0][0]).toContain("%24search=%22nick%22");
  });

  it("returns cached result without hitting Graph", async () => {
    mockSafeQueryPeople.mockResolvedValueOnce({
      rows: [
        { person_id: "p1", display_name: "Alice", email: "a@x", score: 0.9, source: "", cached_at: new Date().toISOString() },
      ],
    });
    const { suggestPeople } = await import("@/lib/integrations/microsoft-people");
    const out = await suggestPeople("u-1", "alice");
    expect(out).toHaveLength(1);
    expect(fetchMockPeople).not.toHaveBeenCalled();
    expect(mockTrackPeople).toHaveBeenCalledWith(
      "system.ms_people_suggestions_fetched",
      "u-1",
      "system",
      expect.objectContaining({ from_cache: true }),
    );
  });

  it("returns [] + analytics on 403", async () => {
    fetchMockPeople.mockResolvedValueOnce(errRespPpl(403));
    const { suggestPeople } = await import("@/lib/integrations/microsoft-people");
    const out = await suggestPeople("u-1", "x");
    expect(out).toEqual([]);
    expect(mockTrackPeople).toHaveBeenCalledWith(
      "system.ms_people_suggestions_fetched",
      "u-1",
      "system",
      expect.objectContaining({ scope_missing: true }),
    );
  });
});
