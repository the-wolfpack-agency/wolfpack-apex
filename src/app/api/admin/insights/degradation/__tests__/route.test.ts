/**
 * What broke while somebody was waiting, as a contract.
 *
 * WHY THE PANEL EXISTS. /admin/insights had six sections and none was about
 * failure. An operator could see which controls were shown to the wrong roles
 * and what model spend looked like, and could not see that the product had
 * spent an afternoon telling people their documents were missing.
 *
 * THE ASSERTION THAT MATTERS MOST is the unreadable one. If the event store
 * cannot be read this must say so rather than return zeros, because a quiet
 * month and a broken query render identically otherwise. That is the exact
 * defect this whole panel exists to surface, and shipping it inside the fix
 * would be its own punchline.
 */

const mockQuery = jest.fn();
const mockGetUser = jest.fn();

jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));
jest.mock("@/lib/auth", () => ({ getUserFromRequest: (...a: unknown[]) => mockGetUser(...a) }));

import { GET } from "@/app/api/admin/insights/degradation/route";
import { NextRequest } from "next/server";

function req(): NextRequest {
  return new NextRequest("http://localhost/api/admin/insights/degradation", {
    headers: { authorization: "Bearer t" },
  });
}

/** Counts in call order, then the kinds breakdown. */
function respondWith(counts: number[], kinds: string[] = []) {
  let i = 0;
  mockQuery.mockImplementation((sql: string) => {
    if (String(sql).includes("metadata->>'kinds'")) {
      return Promise.resolve({ rows: kinds.map((k) => ({ kinds: k })) });
    }
    return Promise.resolve({ rows: [{ n: String(counts[i++] ?? 0) }] });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockReturnValue({ id: "u1", role: "cto" });
});

describe("who may read it", () => {
  it("401s without a session", async () => {
    mockGetUser.mockReturnValue(null);
    expect((await GET(req())).status).toBe(401);
  });

  it("403s for a role that is not an operator", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "member" });
    expect((await GET(req())).status).toBe(403);
  });

  it.each(["ceo", "cto", "evp"])("200s for %s", async (role) => {
    mockGetUser.mockReturnValue({ id: "u1", role });
    respondWith([0, 0, 0, 0]);
    expect((await GET(req())).status).toBe(200);
  });
});

describe("what it reports", () => {
  it("counts degraded answers, recoveries and the two named failures", async () => {
    respondWith([7, 3, 12, 1]);
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({
      readable: true,
      degradedAnswers: 7,
      retriesRecovered: 3,
      semanticDegraded: 12,
      knowledgeLookupFailures: 1,
    });
  });

  /* The count says there is a problem; only this says where to go. */
  it("breaks the degradations down by dependency, most frequent first", async () => {
    respondWith([3, 0, 0, 0], ["model", "semantic_search,model", "model"]);
    const body = await (await GET(req())).json();
    expect(body.causes).toEqual([
      { kind: "model", count: 3 },
      { kind: "semantic_search", count: 1 },
    ]);
  });

  it("reports no causes rather than inventing one when nothing degraded", async () => {
    respondWith([0, 0, 0, 0], []);
    const body = await (await GET(req())).json();
    expect(body.causes).toEqual([]);
    expect(body.degradedAnswers).toBe(0);
  });
});

/**
 * THE ONE THAT WOULD BE EMBARRASSING TO GET WRONG. A panel about failures
 * being unable to distinguish its own failure from good news is the same
 * defect it was built to report.
 */
describe("when the event store cannot be read", () => {
  it("says so instead of returning zeros", async () => {
    mockQuery.mockRejectedValue(new Error("connection refused"));
    const body = await (await GET(req())).json();
    expect(body.readable).toBe(false);
    expect(body.degradedAnswers).toBeUndefined();
  });

  /* A breakdown that fails must not take the headline with it: knowing how
     many is still worth having without knowing which. */
  it("keeps the headline when only the breakdown fails", async () => {
    let i = 0;
    mockQuery.mockImplementation((sql: string) => {
      if (String(sql).includes("metadata->>'kinds'")) return Promise.reject(new Error("nope"));
      return Promise.resolve({ rows: [{ n: String([5, 1, 0, 0][i++] ?? 0) }] });
    });
    const body = await (await GET(req())).json();
    expect(body.readable).toBe(true);
    expect(body.degradedAnswers).toBe(5);
    expect(body.causes).toEqual([]);
  });
});
