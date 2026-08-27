/**
 * The Phase 1 shop window: the gate, and the honest zero.
 *
 * This is the surface a client is shown before their own infrastructure
 * exists, so the failure that matters is not a crash. It is a figure that
 * reads as a capability when nothing was measured, or a zero that reads as a
 * clean bill of health when the control never ran.
 */

const mockGetUser = jest.fn();
const mockSnapshot = jest.fn();

jest.mock("@/lib/auth", () => ({ getUserFromRequest: (...a: unknown[]) => mockGetUser(...a) }));
jest.mock("@/lib/insights/capability-snapshot", () => ({
  readCapabilitySnapshot: (...a: unknown[]) => mockSnapshot(...a),
}));

import { GET } from "../route";

const req = (days?: string) =>
  ({
    headers: { get: () => "Bearer t" },
    nextUrl: { searchParams: new URLSearchParams(days ? { days } : {}) },
  }) as never;

const SNAP = {
  windowDays: 90,
  takenAt: "2026-08-27T00:00:00.000Z",
  gate: {
    actionsAuthorized: { value: 4209, detail: "gated" },
    checkpointsSigned: { value: 332, detail: "signed" },
  },
  efficiency: {
    deterministicSharePct: { value: 99, detail: "no model" },
    modelCalls: { value: 577, detail: "calls" },
    cheapTierPct: { value: 81, detail: "cheap" },
    spendUsd: { value: 0.6, detail: "spend" },
  },
  safety: {
    responsesRedacted: { value: 0, detail: "none needed" },
    responsesFlagged: { value: 0, detail: "none withheld" },
    inspectorProven: true,
  },
  retrieval: {
    chunksEmbeddedPct: { value: 100, detail: "embedded" },
    answerableDocuments: { value: 93, detail: "quotable" },
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockReturnValue({ role: "cto" });
  mockSnapshot.mockResolvedValue(SNAP);
});

describe("the gate", () => {
  it("401s an unauthenticated caller", async () => {
    mockGetUser.mockReturnValue(null);
    expect((await GET(req())).status).toBe(401);
  });

  it("403s a role that may not read it", async () => {
    mockGetUser.mockReturnValue({ role: "sales" });
    expect((await GET(req())).status).toBe(403);
  });

  it.each(["cto", "ceo", "evp"])("200s for %s", async (role) => {
    mockGetUser.mockReturnValue({ role });
    expect((await GET(req())).status).toBe(200);
  });
});

describe("the payload", () => {
  it("returns the snapshot", async () => {
    const body = await (await GET(req())).json();
    expect(body.readable).toBe(true);
    expect(body.snapshot.efficiency.deterministicSharePct.value).toBe(99);
    expect(body.snapshot.gate.actionsAuthorized.value).toBe(4209);
  });

  it("defaults to 90 days and clamps an absurd window", async () => {
    await GET(req());
    expect(mockSnapshot).toHaveBeenCalledWith(90);
    await GET(req("99999"));
    expect(mockSnapshot).toHaveBeenLastCalledWith(365);
  });

  it("reports unreadable rather than a snapshot of zeros when the read throws", async () => {
    /* A page showing 0% deterministic and $0 spend because the event store was
       down would tell a client this product does nothing. */
    mockSnapshot.mockRejectedValue(new Error("db down"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.readable).toBe(false);
    expect(body.snapshot).toBeUndefined();
  });

  it("is never cached, because the point is that it is current", async () => {
    expect((await GET(req())).headers.get("Cache-Control")).toMatch(/no-store/);
  });

  it("carries inspectorProven, so a zero can be read as good news", async () => {
    /* Without this flag a client cannot tell "nothing needed redacting" from
       "the redactor was never wired up", which is exactly the ambiguity this
       codebase spent a week removing. */
    const body = await (await GET(req())).json();
    expect(body.snapshot.safety.inspectorProven).toBe(true);
    expect(body.snapshot.safety.responsesRedacted.value).toBe(0);
  });
});
