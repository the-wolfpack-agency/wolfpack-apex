/**
 * The client-facing document reports state rather than intent.
 *
 * /playbook is what a client is handed, and until 2026-08-26 every number in
 * it was a sentence somebody typed. Three had drifted: "eighteen integrations"
 * while twelve had ever run, "a second model reviews every answer" while it
 * had reviewed none in ninety days, and a post-quantum claim for something not
 * built. A document that asserts goes stale silently.
 *
 * So the readings are read. These tests are mostly about the UNHAPPY case,
 * because a client-facing page is the very last place a zero may stand in for
 * "we could not measure it".
 */

const mockAuditRouting = jest.fn();
const mockGatherEvidence = jest.fn();
const mockSnapshot = jest.fn();

jest.mock("@/lib/assistant/routing-audit", () => ({
  auditRouting: (...a: unknown[]) => mockAuditRouting(...a),
}));
jest.mock("@/lib/integrations/evidence", () => ({
  gatherEvidence: (...a: unknown[]) => mockGatherEvidence(...a),
  verdict: (e: { events: number }) => (e.events > 0 ? "active" : "unproven"),
}));
jest.mock("@/lib/pilot/phase-one", () => ({
  getPhaseOneSnapshot: (...a: unknown[]) => mockSnapshot(...a),
}));

import { readPlaybookReadiness } from "@/lib/playbook/readiness";

const line = (r: Awaited<ReturnType<typeof readPlaybookReadiness>>, needle: string) =>
  r.lines.find((l) => l.label.toLowerCase().includes(needle))!;

beforeEach(() => {
  jest.clearAllMocks();
  mockAuditRouting.mockResolvedValue({ total: 36, reachedOne: 30, byGroup: {} });
  mockGatherEvidence.mockResolvedValue([
    { events: 5 }, { events: 1 }, { events: 0 }, { events: 0 },
  ]);
  mockSnapshot.mockResolvedValue({
    passages: 4769, libraries: 6, toolAnswers: 880, modelAnswers: 120, declined: 0, readable: true,
  });
});

describe("the measured lines", () => {
  it("reports routing as a share of the corpus, not a bare count", async () => {
    const r = await readPlaybookReadiness();
    expect(line(r, "routed").value).toBe("83%");
    expect(line(r, "routed").detail).toContain("30 of 36");
  });

  it("says how many integrations have RUN, not how many exist", async () => {
    /* The exact sentence the handoff says never to get wrong: say twelve have
       run in production, never eighteen integrations. */
    const r = await readPlaybookReadiness();
    expect(line(r, "integrations").value).toBe("2 of 4");
  });

  it("reports the deterministic share the product is sold on", async () => {
    const r = await readPlaybookReadiness();
    expect(line(r, "without a model").value).toBe("88%");
    expect(line(r, "passages").value).toBe("4,769");
  });
});

describe("a reading that could not be taken never becomes a zero", () => {
  it("says so when the event store is unreachable", async () => {
    mockGatherEvidence.mockRejectedValue(new Error("db down"));
    const r = await readPlaybookReadiness();
    const l = line(r, "integrations");
    expect(l.value).toBeNull();
    expect(l.detail).toMatch(/unmeasured rather than zero/i);
  });

  it("says so when the phase-one figures are unreadable", async () => {
    mockSnapshot.mockResolvedValue({ readable: false, passages: 0, libraries: 0, toolAnswers: 0, modelAnswers: 0, declined: 0 });
    const r = await readPlaybookReadiness();
    expect(line(r, "without a model").value).toBeNull();
    /* And it must NOT publish "0 passages" from an unreadable snapshot. */
    expect(r.lines.find((l) => l.label.includes("Passages"))).toBeUndefined();
  });

  it("distinguishes nothing asked yet from a model answering everything", async () => {
    /* A share of zero questions is not zero percent deterministic, which would
       be the exact opposite of the claim this line exists to make. */
    mockSnapshot.mockResolvedValue({
      passages: 10, libraries: 1, toolAnswers: 0, modelAnswers: 0, declined: 0, readable: true,
    });
    const r = await readPlaybookReadiness();
    const l = line(r, "without a model");
    expect(l.value).toBeNull();
    expect(l.detail).toMatch(/division by zero rather than a zero/i);
  });

  it("survives the routing audit throwing", async () => {
    mockAuditRouting.mockRejectedValue(new Error("registry broken"));
    const r = await readPlaybookReadiness();
    expect(line(r, "routed").value).toBeNull();
    /* One dead reading must not take the other lines down with it. */
    expect(line(r, "integrations").value).toBe("2 of 4");
  });

  it("never puts an em dash in front of a client", async () => {
    mockGatherEvidence.mockRejectedValue(new Error("x"));
    const r = await readPlaybookReadiness();
    for (const l of r.lines) {
      expect(l.label).not.toContain("—");
      expect(l.detail).not.toContain("—");
      expect(l.value ?? "").not.toContain("—");
    }
  });
});
