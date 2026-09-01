/**
 * The gist route, as a contract.
 *
 * The assertion that matters most is the unreadable one. A page arguing that
 * the product learns from its own behavior must not report a clean quarter
 * when it simply could not read the store, which is the failure this codebase
 * has now found in four separate places.
 */

const mockGetUser = jest.fn();
const mockExtract = jest.fn();

jest.mock("@/lib/auth", () => ({ getUserFromRequest: (...a: unknown[]) => mockGetUser(...a) }));
jest.mock("@/lib/gist/extract", () => ({ extractGists: (...a: unknown[]) => mockExtract(...a) }));

import { GET } from "@/app/api/admin/gist/route";
import { NextRequest } from "next/server";

function req(days?: number): NextRequest {
  const url = `http://localhost/api/admin/gist${days ? `?days=${days}` : ""}`;
  return new NextRequest(url, { headers: { authorization: "Bearer t" } });
}

function gist(over: Record<string, unknown> = {}) {
  return {
    shape: "other",
    origin: "tool",
    answerLength: "medium",
    questionLength: "short",
    hadSources: false,
    admittedMiss: false,
    outcome: "continued",
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockReturnValue({ id: "u1", role: "cto" });
  mockExtract.mockResolvedValue([]);
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
    expect((await GET(req())).status).toBe(200);
  });
});

describe("what it returns", () => {
  it("reports outcomes, signals and the vocabulary", async () => {
    mockExtract.mockResolvedValue([
      ...Array.from({ length: 40 }, () => gist({ origin: "ai", outcome: "dead_end" })),
      ...Array.from({ length: 60 }, () => gist({ origin: "tool", outcome: "continued" })),
    ]);
    const body = await (await GET(req())).json();

    expect(body.readable).toBe(true);
    expect(body.turns).toBe(100);
    expect(body.outcomes.dead_end).toBe(40);
    expect(body.signals.length).toBeGreaterThan(0);
    /* The vocabulary IS the safety argument, so the page must be able to show
       it rather than describe it. */
    expect(body.vocabulary.origin).toContain("brain");
    expect(body.vocabulary.outcome).toContain("dead_end");
  });

  it("caps an absurd window rather than reading the whole table", async () => {
    await GET(req(99999));
    expect(mockExtract).toHaveBeenCalledWith(365);
  });

  it("defaults to ninety days", async () => {
    await GET(req());
    expect(mockExtract).toHaveBeenCalledWith(90);
  });

  /* No gist is a real state on a fresh deployment, and it must render as
     "nothing yet" rather than as an error. */
  it("handles an empty corpus", async () => {
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ readable: true, turns: 0 });
    expect(body.usable).toEqual([]);
  });
});

describe("when the store cannot be read", () => {
  it("says so instead of reporting a clean quarter", async () => {
    mockExtract.mockRejectedValue(new Error("connection refused"));
    const body = await (await GET(req())).json();
    expect(body.readable).toBe(false);
    expect(body.turns).toBeUndefined();
  });
});
