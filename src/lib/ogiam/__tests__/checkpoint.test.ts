/**
 * verifyChain + createCheckpoint tests. The chain math (recompute + linkage +
 * tamper detection) is exercised directly; createCheckpoint is exercised against
 * a mocked db and a stub signer (signs the head, records it, no-ops when nothing
 * is new, and refuses to notarize a chain that does not verify).
 */

import { createHash } from "crypto";

const mockSafeQuery = jest.fn();
const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
  query: (...a: unknown[]) => mockQuery(...a),
}));
const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));

import { verifyChain, createCheckpoint } from "@/lib/ogiam/checkpoint";
import { OGIAM_GENESIS_HASH } from "@/lib/ogiam/ledger";
import type { OgiamSigner } from "@/lib/ogiam/signing";

function entry(prev: string, payload: string): string {
  return createHash("sha256").update(prev).update("|").update(payload).digest("hex");
}

/** Build a valid N-row chain. */
function validChain(n: number) {
  const rows: { seq: string; prev_hash: string; entry_hash: string; hash_payload: string | null }[] = [];
  let prev = OGIAM_GENESIS_HASH;
  for (let i = 1; i <= n; i++) {
    const payload = JSON.stringify({ seq: i });
    const e = entry(prev, payload);
    rows.push({ seq: String(i), prev_hash: prev, entry_hash: e, hash_payload: payload });
    prev = e;
  }
  return rows;
}

beforeEach(() => {
  mockSafeQuery.mockReset();
  mockQuery.mockReset();
  mockTrackEvent.mockReset();
});

describe("verifyChain", () => {
  it("verifies a clean chain", async () => {
    mockSafeQuery.mockResolvedValue({ rows: validChain(3) });
    const v = await verifyChain("ws-1");
    expect(v.ok).toBe(true);
    expect(v.verifiedCount).toBe(3);
    expect(v.brokenAtSeq).toBeNull();
    expect(v.headSeq).toBe(3);
  });

  it("detects a tampered entry_hash", async () => {
    const rows = validChain(3);
    rows[1].entry_hash = "f".repeat(64); // tamper row 2
    mockSafeQuery.mockResolvedValue({ rows });
    const v = await verifyChain("ws-1");
    expect(v.ok).toBe(false);
    expect(v.brokenAtSeq).toBe(2);
  });

  it("detects broken linkage (a deleted or reordered row)", async () => {
    const rows = validChain(3);
    rows[2].prev_hash = "0".repeat(64); // row 3 no longer points at row 2
    mockSafeQuery.mockResolvedValue({ rows });
    const v = await verifyChain("ws-1");
    expect(v.ok).toBe(false);
    expect(v.brokenAtSeq).toBe(3);
  });

  it("counts legacy rows (no hash_payload) without failing", async () => {
    const rows = validChain(2);
    rows[1].hash_payload = null; // pre-migration row: linkage still checks
    mockSafeQuery.mockResolvedValue({ rows });
    const v = await verifyChain("ws-1");
    expect(v.ok).toBe(true);
    expect(v.verifiedCount).toBe(1);
    expect(v.legacyCount).toBe(1);
  });
});

function stubSigner(signature: string | null): OgiamSigner {
  return {
    keyId: "test-key",
    algorithm: signature ? "ES256" : "none",
    isProduction: Boolean(signature),
    sign: async () => ({ signature, keyId: "test-key", algorithm: signature ? "ES256" : "none" }),
  };
}

/** Route safeQuery by SQL so createCheckpoint sees the right rows. */
function wireCheckpointReads(chain: ReturnType<typeof validChain>, lastCheckpointSeq: number | null) {
  mockSafeQuery.mockImplementation(async (sql: string) => {
    if (/FROM ogiam_decisions[\s\S]*ORDER BY seq DESC/.test(sql)) {
      const head = chain[chain.length - 1];
      return { rows: head ? [{ seq: head.seq, entry_hash: head.entry_hash }] : [] };
    }
    if (/FROM ogiam_checkpoints/.test(sql)) {
      return { rows: lastCheckpointSeq == null ? [] : [{
        id: "cp-old", workspace_id: "ws-1", through_seq: String(lastCheckpointSeq),
        head_hash: "h", algorithm: "ES256", key_id: "k", signature: "s",
        signed_at: "t", created_at: "t",
      }] };
    }
    if (/ORDER BY seq ASC/.test(sql)) {
      return { rows: chain };
    }
    return { rows: [] };
  });
}

describe("createCheckpoint", () => {
  it("signs the chain head and records a checkpoint", async () => {
    const chain = validChain(3);
    wireCheckpointReads(chain, null);
    mockQuery.mockResolvedValue({ rows: [{ id: "cp-1", created_at: "now" }] });

    const cp = await createCheckpoint("ws-1", stubSigner("SIG"));
    expect(cp).not.toBeNull();
    expect(cp!.throughSeq).toBe(3);
    expect(cp!.signed).toBe(true);
    // Inserted with the head hash + signature.
    const insertParams = mockQuery.mock.calls[0][1];
    expect(insertParams[1]).toBe(3); // through_seq
    expect(insertParams[2]).toBe(chain[2].entry_hash); // head_hash
    expect(insertParams[6]).toBe("SIG"); // signature
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "ogiam.checkpoint_signed", "system", "system",
      expect.objectContaining({ through_seq: 3, signed: true, chain_ok: true }),
    );
  });

  it("records an unsigned checkpoint when no signer is configured", async () => {
    wireCheckpointReads(validChain(2), null);
    mockQuery.mockResolvedValue({ rows: [{ id: "cp-2", created_at: "now" }] });
    const cp = await createCheckpoint("ws-1", stubSigner(null));
    expect(cp!.signed).toBe(false);
    expect(mockQuery.mock.calls[0][1][6]).toBeNull(); // signature null
  });

  it("no-ops when the head is not beyond the last checkpoint", async () => {
    wireCheckpointReads(validChain(3), 3);
    const cp = await createCheckpoint("ws-1", stubSigner("SIG"));
    expect(cp).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("refuses to notarize a chain that does not verify", async () => {
    const chain = validChain(3);
    chain[1].entry_hash = "f".repeat(64); // tamper
    wireCheckpointReads(chain, null);
    const cp = await createCheckpoint("ws-1", stubSigner("SIG"));
    expect(cp).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled(); // no checkpoint written
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "ogiam.checkpoint_signed", "system", "system",
      expect.objectContaining({ signed: false, chain_ok: false }),
    );
  });
});
