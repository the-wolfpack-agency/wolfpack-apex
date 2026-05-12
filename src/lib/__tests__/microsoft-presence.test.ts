/**
 * Microsoft Presence integration tests — fetch, 403 → null, no cache.
 */
 

const mockTrackPresence = jest.fn();
const mockGetValidTokenPresence = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackPresence(...args),
}));
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...args: any[]) => mockGetValidTokenPresence(...args),
}));

const realFetchPresence = global.fetch;
const fetchMockPresence = jest.fn();

beforeAll(() => { (global as any).fetch = fetchMockPresence; });
afterAll(() => { (global as any).fetch = realFetchPresence; });

beforeEach(() => {
  jest.clearAllMocks();
  fetchMockPresence.mockReset();
  mockGetValidTokenPresence.mockResolvedValue({ accessToken: "tok" });
});

function okRespPres(data: unknown): any {
  return { ok: true, status: 200, json: () => Promise.resolve(data), headers: { get: () => null } };
}
function errRespPres(status: number): any {
  return { ok: false, status, json: () => Promise.resolve({}), headers: { get: () => null } };
}

describe("getOwnPresence", () => {
  it("returns normalized presence", async () => {
    fetchMockPresence.mockResolvedValueOnce(okRespPres({
      availability: "Busy",
      activity: "InACall",
      statusMessage: { message: { content: "On a call" } },
    }));
    const { getOwnPresence } = await import("@/lib/integrations/microsoft-presence");
    const p = await getOwnPresence("u-1");
    expect(p).toMatchObject({
      availability: "Busy",
      activity: "InACall",
      statusMessage: "On a call",
    });
    expect(mockTrackPresence).toHaveBeenCalledWith(
      "system.ms_presence_fetched",
      "u-1",
      "system",
      expect.objectContaining({ availability: "Busy", activity: "InACall" }),
    );
  });

  it("returns null on 403 and tracks scope_missing", async () => {
    fetchMockPresence.mockResolvedValueOnce(errRespPres(403));
    const { getOwnPresence } = await import("@/lib/integrations/microsoft-presence");
    const p = await getOwnPresence("u-1");
    expect(p).toBeNull();
    expect(mockTrackPresence).toHaveBeenCalledWith(
      "system.ms_presence_fetched",
      "u-1",
      "system",
      expect.objectContaining({ scope_missing: true }),
    );
  });

  it("returns null on 404", async () => {
    fetchMockPresence.mockResolvedValueOnce(errRespPres(404));
    const { getOwnPresence } = await import("@/lib/integrations/microsoft-presence");
    expect(await getOwnPresence("u-1")).toBeNull();
  });

  it("returns null when token unavailable", async () => {
    mockGetValidTokenPresence.mockResolvedValueOnce(null);
    const { getOwnPresence } = await import("@/lib/integrations/microsoft-presence");
    expect(await getOwnPresence("u-1")).toBeNull();
  });
});
