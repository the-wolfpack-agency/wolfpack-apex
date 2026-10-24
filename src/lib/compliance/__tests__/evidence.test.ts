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

describe("windowed platform evidence (injected executor)", () => {
  /** A fake executor that answers each platform query by a fragment of its SQL. */
  function fakeExec(over: { oauthPlain?: number; connPlain?: number; nonTrivial?: number; signed?: number; enforced?: number; fail?: RegExp } = {}) {
    return async (sql: string) => {
      if (over.fail && over.fail.test(sql)) throw new Error("relation does not exist");
      if (/FROM ogiam_checkpoints/.test(sql)) return { rows: [{ n: over.signed ?? 0, last: over.signed ? "2026-06-30T00:00:00.000Z" : null }] };
      if (/FROM instinct_ms_tokens/.test(sql)) return { rows: [{ total: 6, plaintext: over.oauthPlain ?? 0 }] };
      if (/FROM instinct_qbo_tokens/.test(sql)) return { rows: [{ total: 0, plaintext: 0 }] };
      if (/FROM instinct_connector_credentials/.test(sql)) return { rows: [{ total: 4, plaintext: over.connPlain ?? 0 }] };
      if (/pg_policies/.test(sql)) return { rows: [{ tables: 248, rls_enabled: 33, forced: 0, policies: 33, non_trivial: over.nonTrivial ?? 0, bypass: true, owned: 248 }] };
      if (/FROM ogiam_decisions/.test(sql)) return { rows: [{ decisions: 1261, enforced: over.enforced ?? 0, enforced_blocks: over.enforced ?? 0, enforced_escalations: 0, would_block: 0 }] };
      return { rows: [] };
    };
  }

  test("plaintext OAuth tokens make secretsEncryptedAtRest false even when the probe round-trips", async () => {
    const e = await collectEvidence("w-1", NOW, fakeExec({ oauthPlain: 6 }));
    expect(e.storedOauthPlaintext).toBe(6);
    expect(e.secretsEncryptedAtRest).toBe(false);
  });

  test("no signed checkpoint in the window -> signingActive false whatever the signer", async () => {
    const e = await collectEvidence("w-1", NOW, fakeExec({ signed: 0 }));
    expect(e.signingProven).toBe(false);
    expect(e.signingActive).toBe(false);
  });

  test("USING(true) policies + a bypassing owner role -> dbRlsEnforced false", async () => {
    const e = await collectEvidence("w-1", NOW, fakeExec());
    expect(e.dbRlsEnforced).toBe(false);
  });

  test("gate window counts come from the windowed query, not the lifetime summary", async () => {
    const e = await collectEvidence("w-1", NOW, fakeExec({ enforced: 0 }));
    expect(e.gateWindowMeasured).toBe(true);
    expect(e.gateDecisionsWindow).toBe(1261);
    expect(e.gateEnforcedWindow).toBe(0);
  });

  test("a failing platform query reads as unknown (null), never a pass", async () => {
    const e = await collectEvidence("w-1", NOW, fakeExec({ fail: /instinct_ms_tokens|pg_policies|ogiam_decisions/ }));
    expect(e.storedOauthPlaintext).toBeNull();
    expect(e.secretsEncryptedAtRest).toBe(false);
    expect(e.dbRlsEnforced).toBeNull();
    expect(e.gateWindowMeasured).toBe(false);
  });

  test("no database -> every windowed signal is unmeasured", async () => {
    const e = await collectEvidence("w-1", NOW, null);
    expect(e.gateWindowMeasured).toBe(false);
    expect(e.storedOauthPlaintext).toBeNull();
    expect(e.signingProven).toBe(false);
  });

  test("the red-team is labeled the fixed regression set with its case count", async () => {
    mockListRuns.mockResolvedValue([{ passRate: 1, createdAt: "2026-06-30T06:00:00.000Z", attacksRun: 8 }]);
    const e = await collectEvidence("w-1", NOW, null);
    expect(e.redteamKind).toBe("fixed_regression");
    expect(e.redteamCases).toBe(8);
    expect(e.redteamLastRunAt).toBe("2026-06-30T06:00:00.000Z");
  });
});
