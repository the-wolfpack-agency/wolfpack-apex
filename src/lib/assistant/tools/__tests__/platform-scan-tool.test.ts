/**
 * Reading the scanner from the chat.
 *
 * Almost every test here is about a sentence rather than a number, because the
 * number is easy and the sentence is where this tool can do damage. "No open
 * findings" is the answer somebody repeats in a meeting, and it is only true
 * if a scan ran, over a target that was onboarded, with coverage worth
 * trusting. Three different situations produce a zero and only one of them is
 * good news.
 */
import {
  platformScanFindingsTool,
  matchScanFindingsIntent,
} from "../platform-scan-tool";

jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

const mockTargets = jest.fn();
const mockSummary = jest.fn();
const mockScans = jest.fn();

jest.mock("@/lib/platform-scan/targets-store", () => ({
  listStoredTargets: (...a: unknown[]) => mockTargets(...a),
}));
jest.mock("@/lib/platform-scan/store", () => ({
  summarizeFindings: (...a: unknown[]) => mockSummary(...a),
  listScans: (...a: unknown[]) => mockScans(...a),
}));

const ctx = { userId: "u1", userRole: "cto", workspaceId: "w1" };

const run = async (params = {}) => {
  const res = await platformScanFindingsTool.handler(params as never, ctx as never);
  return res;
};

/** The ordinary case: onboarded, scanned, some findings, good coverage. */
function healthy(over: Record<string, unknown> = {}) {
  mockTargets.mockResolvedValue([{ platform: "beyond", manifest: {} }]);
  mockSummary.mockResolvedValue({
    total: 4,
    bySeverity: { critical: 1, high: 1, medium: 2, low: 0 },
    byCategory: {},
  });
  mockScans.mockResolvedValue([
    {
      id: "s1",
      createdAt: "2026-08-20T09:00:00.000Z",
      coverage: { coverageRatio: 0.92, attempted: 25, succeeded: 23, errored: 2, authRequired: false, authEstablished: false },
      degraded: false,
      ...over,
    },
  ]);
}

beforeEach(() => jest.clearAllMocks());

describe("recognising the question", () => {
  it.each([
    "what did the scan find",
    "open security findings",
    "any scan issues",
    "show me the vulnerability report",
    "platform scan",
  ])("matches %p", (m) => {
    expect(matchScanFindingsIntent(m)).not.toBeNull();
  });

  it("picks up a named platform", () => {
    expect(matchScanFindingsIntent("scan findings for beyond")).toEqual({ platform: "beyond" });
  });

  it("does not mistake our own nouns for a platform name", () => {
    /* "findings for scan results" must not target a platform called "scan". */
    expect(matchScanFindingsIntent("scan findings for the platform")).toEqual({});
  });

  it.each([
    "scan this receipt",
    "scan the document for me",
    "can you scan my invoice",
  ])("leaves %p to the tool that actually does it", (m) => {
    expect(matchScanFindingsIntent(m)).toBeNull();
  });
});

describe("the three different zeroes", () => {
  it("says nothing is onboarded, rather than nothing is wrong", async () => {
    /* The worst possible answer to "any security issues?" on an unscanned
       estate is "no". */
    mockTargets.mockResolvedValue([]);
    mockSummary.mockResolvedValue({ total: 0, bySeverity: {}, byCategory: {} });
    mockScans.mockResolvedValue([]);

    const res = await run();
    expect(res.ok).toBe(true);
    expect((res as { answer: string }).answer).toMatch(/no platform has been onboarded/i);
    expect((res as { answer: string }).answer).not.toMatch(/nothing open/i);
  });

  it("says nothing has been looked at when a target exists but no scan ran", async () => {
    mockTargets.mockResolvedValue([{ platform: "beyond", manifest: {} }]);
    mockSummary.mockResolvedValue({ total: 0, bySeverity: {}, byCategory: {} });
    mockScans.mockResolvedValue([]);

    const answer = (await run()) as { answer: string };
    expect(answer.answer).toMatch(/no scan has run yet/i);
    expect(answer.answer).toMatch(/nothing has been looked at/i);
  });

  it("only reports nothing open when a scan actually ran", async () => {
    healthy();
    mockSummary.mockResolvedValue({ total: 0, bySeverity: {}, byCategory: {} });

    const answer = (await run()) as { answer: string };
    expect(answer.answer).toMatch(/nothing open/i);
    expect(answer.answer).toMatch(/2026-08-20/);
  });
});

describe("coverage travels with every clean-sounding answer", () => {
  it("states coverage alongside the count", async () => {
    /* A clean result over a tenth of the estate is not a clean result. */
    healthy();
    const answer = (await run()) as { answer: string };
    expect(answer.answer).toMatch(/covered 92% of the routes/i);
  });

  it("says coverage is UNKNOWN rather than implying it was complete", async () => {
    /* Null coverage is not zero and is not full. An older run and an external
       ingest both land here, and both would otherwise read as a full sweep. */
    healthy({ coverage: null, degraded: null });
    const answer = (await run()) as { answer: string };
    expect(answer.answer).toMatch(/unknown/i);
    expect(answer.answer).toMatch(/floor rather than a total/i);
  });

  it("calls a degraded run a partial picture", async () => {
    healthy({ coverage: { coverageRatio: 0.31, attempted: 100, succeeded: 31, errored: 69, authRequired: true, authEstablished: false }, degraded: true });
    const answer = (await run()) as { answer: string };
    expect(answer.answer).toMatch(/partial picture/i);
    expect(answer.answer).not.toMatch(/clean bill(?!\.)/i);
  });
});

describe("counting what is open", () => {
  it("lists severities worst first, and omits the empty ones", async () => {
    healthy();
    const answer = (await run()) as { answer: string };
    expect(answer.answer).toMatch(/4 open findings: 1 critical, 1 high, 2 medium\./);
    expect(answer.answer).not.toMatch(/0 low/);
  });

  it("narrows to one platform when asked", async () => {
    healthy();
    await run({ platform: "beyond" });
    expect(mockSummary).toHaveBeenCalledWith("w1", "beyond");
  });

  it("asks about the whole workspace when no platform is named", async () => {
    healthy();
    await run();
    expect(mockSummary).toHaveBeenCalledWith("w1", undefined);
  });

  it("scopes every read to the caller's workspace", async () => {
    healthy();
    await run();
    expect(mockTargets).toHaveBeenCalledWith("w1");
    expect(mockScans).toHaveBeenCalledWith("w1", 1);
  });
});

describe("when the store cannot be read", () => {
  it("refuses rather than answering with an encouraging zero", async () => {
    /* The failure mode being designed against: a database blip rendering as
       "no open findings". */
    mockTargets.mockRejectedValue(new Error("db down"));
    mockSummary.mockResolvedValue({ total: 0, bySeverity: {}, byCategory: {} });
    mockScans.mockResolvedValue([]);

    const res = await run();
    expect(res.ok).toBe(false);
    expect((res as { message: string }).message).toMatch(/not the same as nothing being outstanding/i);
  });
});

describe("what this tool deliberately cannot do", () => {
  it("does not run a scan", async () => {
    /* Scanning sends real traffic at a real system and is gated on verified
       ownership. A regex match must never be able to start one. */
    const source = platformScanFindingsTool.handler.toString();
    expect(source).not.toMatch(/scanPlatform|runScan/);
  });

  it("is not open to every role", async () => {
    expect(platformScanFindingsTool.capability).toBe("lead");
  });

  it("is not marked as a mutation, because it writes nothing", () => {
    expect(platformScanFindingsTool.requiresConfirmation).toBeFalsy();
  });
});
