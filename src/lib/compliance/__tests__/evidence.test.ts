/**
 * Evidence collector. Proves it maps each live source into EvidenceInputs, counts
 * only enforced capabilities, computes red-team recency, and DEGRADES a failing
 * source to its safe default (so a cold system reports gaps, never throws).
 */

const mockVerifyChain = jest.fn();
const mockSummarizeDecisions = jest.fn();
const mockListEnforcementPolicy = jest.fn();
const mockListRuns = jest.fn();
const mockSummarizeSurfaces = jest.fn();

jest.mock("@/lib/audit-log", () => ({ verifyChain: (...a: unknown[]) => mockVerifyChain(...a) }));
jest.mock("@/lib/ogiam/queries", () => ({ summarizeDecisions: (...a: unknown[]) => mockSummarizeDecisions(...a) }));
jest.mock("@/lib/ogiam/enforcement-policy", () => ({ listEnforcementPolicy: (...a: unknown[]) => mockListEnforcementPolicy(...a) }));
jest.mock("@/lib/ai-redteam/store", () => ({ listRuns: (...a: unknown[]) => mockListRuns(...a) }));
jest.mock("@/lib/ai-surface/store", () => ({ summarizeSurfaces: (...a: unknown[]) => mockSummarizeSurfaces(...a) }));

import { collectEvidence } from "../evidence";

const NOW = new Date("2026-06-30T12:00:00.000Z").getTime();

beforeEach(() => {
  jest.resetAllMocks();
  mockVerifyChain.mockResolvedValue({ valid: true, checkedCount: 1200 });
  mockSummarizeDecisions.mockResolvedValue({ total: 5000, would_block: 80, by_tier: {}, by_outcome: {} });
  mockListEnforcementPolicy.mockResolvedValue([{ mode: "enforce" }, { mode: "monitor" }, { mode: "enforce" }]);
  mockListRuns.mockResolvedValue([{ passRate: 1, createdAt: "2026-06-30T06:00:00.000Z" }]);
  mockSummarizeSurfaces.mockResolvedValue({ total: 40, ungoverned: 3, byKind: {}, byProvider: {}, byRisk: {} });
});

test("maps every live source into EvidenceInputs", async () => {
  const e = await collectEvidence("w-1", NOW);
  expect(e).toMatchObject({
    auditChainValid: true,
    auditEntries: 1200,
    gateDecisions: 5000,
    gateWouldBlock: 80,
    enforceCapabilities: 2, // only the two 'enforce' rows
    redteamPassRate: 1,
    redteamRecent: true,
    aiSurfacesTotal: 40,
    ungovernedAiSurfaces: 3,
  });
});

test("red-team older than the recency window is not 'recent'", async () => {
  mockListRuns.mockResolvedValue([{ passRate: 1, createdAt: "2026-06-01T00:00:00.000Z" }]);
  const e = await collectEvidence("w-1", NOW);
  expect(e.redteamRecent).toBe(false);
  expect(e.redteamPassRate).toBe(1);
});

test("no red-team runs -> passRate null", async () => {
  mockListRuns.mockResolvedValue([]);
  const e = await collectEvidence("w-1", NOW);
  expect(e.redteamPassRate).toBeNull();
  expect(e.redteamRecent).toBe(false);
});

test("a failing source degrades to its safe default, never throws", async () => {
  mockVerifyChain.mockRejectedValue(new Error("db down"));
  mockSummarizeSurfaces.mockRejectedValue(new Error("db down"));
  const e = await collectEvidence("w-1", NOW);
  expect(e.auditChainValid).toBe(false);
  expect(e.auditEntries).toBe(0);
  expect(e.aiSurfacesTotal).toBe(0);
  // other sources still populated
  expect(e.gateDecisions).toBe(5000);
});

test("an unverified chain with entries is not counted as valid", async () => {
  mockVerifyChain.mockResolvedValue({ valid: false, checkedCount: 1200 });
  const e = await collectEvidence("w-1", NOW);
  expect(e.auditChainValid).toBe(false);
  expect(e.auditEntries).toBe(1200);
});
