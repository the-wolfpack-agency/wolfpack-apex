/** @jest-environment node */
const query = jest.fn();
const safeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ hasDatabase: () => true, query: (...a: unknown[]) => query(...a), safeQuery: (...a: unknown[]) => safeQuery(...a) }));
import { getAuditChainHead, publishAuditAnchor, verifyExternalAnchors } from "@/lib/forcefield/audit-anchor";

beforeEach(() => { query.mockReset(); safeQuery.mockReset(); query.mockResolvedValue({ rows: [] }); });

it("reads the chain head (latest seq + entry_hash)", async () => {
  safeQuery.mockResolvedValueOnce({ rows: [{ seq: "509", entry_hash: "h509" }], fromCache: false });
  expect(await getAuditChainHead()).toEqual({ seq: 509, entryHash: "h509" });
});

it("publishes the head to the external witness and records it locally", async () => {
  process.env.FORCEFIELD_AUDIT_ANCHOR_URL = "https://witness.example/anchor";
  safeQuery.mockResolvedValueOnce({ rows: [{ seq: "42", entry_hash: "hABC" }], fromCache: false }); // head
  const fetchImpl = jest.fn().mockResolvedValue({ ok: true, headers: { get: () => "receipt-1" } });
  const anchor = await publishAuditAnchor({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1000 });
  expect(anchor).toEqual({ seq: 42, entryHash: "hABC", delivered: true });
  // posted the signed head to the external URL
  expect(fetchImpl).toHaveBeenCalledWith("https://witness.example/anchor", expect.objectContaining({ method: "POST" }));
  // recorded locally for later verification
  expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO instinct_audit_external_anchors"), expect.arrayContaining([42, "hABC"]));
  delete process.env.FORCEFIELD_AUDIT_ANCHOR_URL;
});

it("verifies the live DB against anchors and DETECTS a rewritten row (tamper)", async () => {
  // one anchor recorded at seq 42 with hash hABC
  safeQuery.mockResolvedValueOnce({ rows: [{ seq: "42", entry_hash: "hABC" }], fromCache: false }); // anchors list
  // the live DB now has a DIFFERENT hash at seq 42 -> rewritten
  safeQuery.mockResolvedValueOnce({ rows: [{ entry_hash: "hEVIL" }], fromCache: false });
  const v = await verifyExternalAnchors();
  expect(v.ok).toBe(false);
  expect(v.mismatches).toEqual([42]);
  expect(v.matches).toBe(0);
});

it("verify passes when the live DB still matches the anchor", async () => {
  safeQuery.mockResolvedValueOnce({ rows: [{ seq: "42", entry_hash: "hABC" }], fromCache: false });
  safeQuery.mockResolvedValueOnce({ rows: [{ entry_hash: "hABC" }], fromCache: false });
  const v = await verifyExternalAnchors();
  expect(v.ok).toBe(true);
  expect(v.matches).toBe(1);
  expect(v.mismatches).toEqual([]);
});
