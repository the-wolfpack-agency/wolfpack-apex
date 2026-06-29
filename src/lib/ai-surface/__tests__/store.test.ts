/**
 * AI surface store. Proves deterministic ids (re-scan upserts, not duplicates),
 * workspace-scoped + ON CONFLICT upsert SQL with workspace_id supplied, the
 * workspace-scoped list query (incl. target + ungoverned filters), and the pure
 * summarizer. db is mocked.
 */

const mockSafeQuery = jest.fn();
const mockWithTransaction = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
  withTransaction: (cb: unknown) => mockWithTransaction(cb),
}));

import { surfaceId, upsertSurfaces, listSurfaces, summarize, type AiSurfaceRecord } from "../store";
import type { AiSurface } from "../types";

const surf = (p: Partial<AiSurface> = {}): AiSurface => ({
  kind: "ai_sdk",
  provider: "openai",
  location: "src/x.ts:1",
  governed: false,
  risk: "medium",
  evidence: { snippet: "import openai" },
  ...p,
});

beforeEach(() => {
  jest.resetAllMocks();
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
  // withTransaction(cb) invokes cb with a tx whose write we can assert.
  mockWithTransaction.mockImplementation(async (cb: (tx: { write: jest.Mock }) => unknown) => {
    const tx = { write: jest.fn().mockResolvedValue({ rows: [] }) };
    const out = await cb(tx);
    (mockWithTransaction as unknown as { lastTx?: typeof tx }).lastTx = tx;
    return out;
  });
});

test("surfaceId is deterministic, stable, and prefixed", () => {
  const a = surfaceId("w", "repo", "ai_sdk", "openai", "src/x.ts:1");
  const b = surfaceId("w", "repo", "ai_sdk", "openai", "src/x.ts:1");
  const c = surfaceId("w", "repo", "ai_sdk", "anthropic", "src/x.ts:1");
  expect(a).toBe(b);
  expect(a).not.toBe(c);
  expect(a).toMatch(/^ais_[0-9a-f]{24}$/);
});

test("upsertSurfaces writes each surface atomically with workspace_id + ON CONFLICT", async () => {
  const n = await upsertSurfaces("w-1", "repo", [surf(), surf({ provider: "anthropic" })]);
  expect(n).toBe(2);
  const tx = (mockWithTransaction as unknown as { lastTx: { write: jest.Mock } }).lastTx;
  expect(tx.write).toHaveBeenCalledTimes(2);
  const [sql, args] = tx.write.mock.calls[0];
  expect(sql).toMatch(/INSERT INTO instinct_ai_surfaces/i);
  expect(sql).toMatch(/ON CONFLICT \(id\) DO UPDATE/i);
  expect(sql).toMatch(/workspace_id/i);
  expect(args[1]).toBe("w-1"); // workspace_id bound
  expect(args[2]).toBe("repo"); // target bound
});

test("upsertSurfaces with no surfaces does nothing (no transaction)", async () => {
  expect(await upsertSurfaces("w-1", "repo", [])).toBe(0);
  expect(mockWithTransaction).not.toHaveBeenCalled();
});

test("listSurfaces is workspace-scoped and applies target + ungoverned filters", async () => {
  await listSurfaces("w-1", { target: "repo", ungovernedOnly: true });
  const [sql, params] = mockSafeQuery.mock.calls[0];
  expect(sql).toMatch(/FROM instinct_ai_surfaces/i);
  expect(sql).toMatch(/workspace_id = \$1/);
  expect(sql).toMatch(/target = \$2/);
  expect(sql).toMatch(/governed = false/);
  expect(params).toEqual(["w-1", "repo"]);
});

test("summarize rolls up totals, ungoverned, and by kind/provider/risk", () => {
  const recs: AiSurfaceRecord[] = [
    { ...surf(), id: "1", target: "r", firstSeenAt: "", lastSeenAt: "" },
    { ...surf({ provider: "anthropic", risk: "critical", kind: "api_key", governed: false }), id: "2", target: "r", firstSeenAt: "", lastSeenAt: "" },
    { ...surf({ governed: true }), id: "3", target: "r", firstSeenAt: "", lastSeenAt: "" },
  ];
  const s = summarize(recs);
  expect(s.total).toBe(3);
  expect(s.ungoverned).toBe(2);
  expect(s.byProvider).toEqual({ openai: 2, anthropic: 1 });
  expect(s.byKind).toEqual({ ai_sdk: 2, api_key: 1 });
  expect(s.byRisk).toEqual({ medium: 2, critical: 1 });
});
