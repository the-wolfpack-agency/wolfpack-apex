/**
 * /api/people/suggest route tests.
 */
 

const mockGetUserPpl = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: unknown[]) => mockGetUserPpl(...a),
}));

const mockSuggest = jest.fn();
class FakeGraphPeopleErr extends Error {
  status: number;
  constructor(s: number, m: string) { super(m); this.name = "GraphPeopleError"; this.status = s; }
}
jest.mock("@/lib/integrations/microsoft-people", () => ({
  suggestPeople: (...a: unknown[]) => mockSuggest(...a),
  GraphPeopleError: FakeGraphPeopleErr,
}));

import { GET as peopleGET } from "@/app/api/people/suggest/route";

function mkReq(url: string, auth?: string): any {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request(url, { method: "GET", headers }) as any;
}

beforeEach(() => jest.clearAllMocks());

describe("GET /api/people/suggest", () => {
  it("401 without auth", async () => {
    mockGetUserPpl.mockReturnValue(null);
    const res = await peopleGET(mkReq("http://test/api/people/suggest"));
    expect(res.status).toBe(401);
  });

  it("passes q and top to suggestPeople", async () => {
    mockGetUserPpl.mockReturnValue({ id: "u", role: "cto" });
    mockSuggest.mockResolvedValue([{ personId: "p1", displayName: "A", email: "a@x", score: 0.5, source: "" }]);
    const res = await peopleGET(mkReq("http://test/api/people/suggest?q=ali&top=5", "Bearer x"));
    expect(res.status).toBe(200);
    expect(mockSuggest).toHaveBeenCalledWith("u", "ali", 5);
    const data = await res.json();
    expect(data.suggestions).toHaveLength(1);
  });

  it("401 when Microsoft not connected", async () => {
    mockGetUserPpl.mockReturnValue({ id: "u", role: "cto" });
    mockSuggest.mockRejectedValue(new FakeGraphPeopleErr(401, "noop"));
    const res = await peopleGET(mkReq("http://test/api/people/suggest?q=x", "Bearer x"));
    expect(res.status).toBe(401);
  });

  it("caps top at 50", async () => {
    mockGetUserPpl.mockReturnValue({ id: "u", role: "cto" });
    mockSuggest.mockResolvedValue([]);
    await peopleGET(mkReq("http://test/api/people/suggest?top=9999", "Bearer x"));
    expect(mockSuggest).toHaveBeenCalledWith("u", undefined, 50);
  });
});
