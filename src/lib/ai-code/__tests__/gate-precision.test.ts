/**
 * Per-rule gate precision: the pure summarizer (join flags + human verdicts,
 * noisiest first, no inferred precision) + the never-throwing loader.
 */
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));

import { summarizeGatePrecision, loadGatePrecision } from "@/lib/ai-code/gate-precision";

beforeEach(() => jest.clearAllMocks());

describe("summarizeGatePrecision", () => {
  it("joins flag counts with human verdicts per class; wrongRate = wrong/reviewed", () => {
    const p = summarizeGatePrecision(
      [{ klass: "logged_credential", n: 10 }, { klass: "sql_injection", n: 4 }],
      [
        { klass: "logged_credential", verdict: "wrong", n: 6 },
        { klass: "logged_credential", verdict: "valid", n: 2 },
        { klass: "sql_injection", verdict: "valid", n: 3 },
      ],
      30,
    );
    const lc = p.classes.find((c) => c.findingClass === "logged_credential")!;
    expect(lc).toMatchObject({ flagged: 10, reviewed: 8, wrong: 6, valid: 2, acceptedRisk: 0 });
    expect(lc.wrongRate).toBeCloseTo(6 / 8, 5);
    // noisiest first: logged_credential (0.75) before sql_injection (0.0)
    expect(p.classes[0].findingClass).toBe("logged_credential");
  });

  it("wrongRate is NULL until a human reviews it (never inferred)", () => {
    const p = summarizeGatePrecision([{ klass: "ssrf", n: 5 }], [], 30);
    expect(p.classes[0]).toMatchObject({ findingClass: "ssrf", flagged: 5, reviewed: 0, wrongRate: null });
  });

  it("counts accepted_risk distinctly from wrong", () => {
    const p = summarizeGatePrecision([{ klass: "x", n: 2 }], [{ klass: "x", verdict: "accepted_risk", n: 2 }], 30);
    expect(p.classes[0]).toMatchObject({ acceptedRisk: 2, wrong: 0, wrongRate: 0 });
  });
});

describe("loadGatePrecision", () => {
  it("reads flags + reviews workspace-scoped and summarizes", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [{ klass: "logged_credential", n: 3 }] })
      .mockResolvedValueOnce({ rows: [{ klass: "logged_credential", verdict: "wrong", n: 2 }] });
    const p = await loadGatePrecision("w1", 30);
    expect(mockSafeQuery.mock.calls[0][1]).toEqual(["30", "w1"]);
    expect(mockSafeQuery.mock.calls[1][1]).toEqual(["30", "w1"]);
    expect(p.classes[0]).toMatchObject({ findingClass: "logged_credential", flagged: 3, wrong: 2 });
    expect(p.classes[0].wrongRate).toBeCloseTo(2 / 2, 5);
  });
  it("empty on no data (never throws)", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    expect((await loadGatePrecision("w1")).classes).toEqual([]);
  });
});
