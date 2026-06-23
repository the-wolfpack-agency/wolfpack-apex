/**
 * Ledger hash-chain primitive tests. The DB write path is covered by the route
 * and integration tests; here we pin the tamper-evidence math: the chain is
 * deterministic, order-independent in field serialization, and sensitive to any
 * change in the prior hash or the committed fields.
 */

import { computeOgiamEntryHash, OGIAM_GENESIS_HASH } from "@/lib/ogiam/ledger";

const fields = {
  seq: 1,
  ts: "2026-06-24T00:00:00.000Z",
  workspace_id: "ws-1",
  tool: "get_calendar",
  intended_outcome: "allow",
  params_hash: "abc",
};

describe("computeOgiamEntryHash", () => {
  it("is a 64-char hex sha256", () => {
    const h = computeOgiamEntryHash(OGIAM_GENESIS_HASH, fields);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic and key-order independent", () => {
    const h1 = computeOgiamEntryHash(OGIAM_GENESIS_HASH, fields);
    const reordered = { params_hash: "abc", tool: "get_calendar", seq: 1, ts: fields.ts, intended_outcome: "allow", workspace_id: "ws-1" };
    const h2 = computeOgiamEntryHash(OGIAM_GENESIS_HASH, reordered);
    expect(h1).toBe(h2);
  });

  it("changes when the prior hash changes (chaining)", () => {
    const a = computeOgiamEntryHash(OGIAM_GENESIS_HASH, fields);
    const b = computeOgiamEntryHash("some-other-prev-hash", fields);
    expect(a).not.toBe(b);
  });

  it("changes when any committed field changes (tamper evidence)", () => {
    const a = computeOgiamEntryHash(OGIAM_GENESIS_HASH, fields);
    const b = computeOgiamEntryHash(OGIAM_GENESIS_HASH, { ...fields, intended_outcome: "deny" });
    expect(a).not.toBe(b);
  });
});
