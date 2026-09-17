/**
 * BYO model keys - the SECURITY invariants, proven without a database.
 *
 * The real AES-256-GCM crypto (secret-storage) is used; only the db layer is
 * mocked, so these assert exactly what reaches (and leaves) storage: the key is
 * encrypted before it is written, the list carries only a hint, and the one path
 * back to plaintext round-trips.
 */
const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));

import { setModelKey, listModelKeys, getDecryptedModelKey } from "../model-keys";
import { encryptSecret } from "@/lib/crypto/secret-storage";

const OLD_ENV = process.env.DATABASE_URL;
beforeAll(() => { process.env.DATABASE_URL = "postgres://test"; });
afterAll(() => {
  // Restore precisely: assigning `undefined` would set the STRING "undefined"
  // (truthy), leaking a fake DB into other tests in this worker.
  if (OLD_ENV === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = OLD_ENV;
});
beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [{ id: "k1", created_at: "2026-09-17T00:00:00Z" }], rowCount: 1 });
});

describe("model-keys security", () => {
  it("encrypts the key BEFORE it reaches the database - never stores plaintext", async () => {
    const summary = await setModelKey({
      workspaceId: "w1", provider: "openai", plaintextKey: "sk-super-secret-1234", createdBy: "u1",
    });

    const params = mockQuery.mock.calls[0][1] as unknown[];
    const storedEncrypted = params[3] as string; // encrypted_key column
    expect(storedEncrypted).toMatch(/^v1\./); // an AES-256-GCM token
    expect(storedEncrypted).not.toContain("sk-super-secret-1234"); // plaintext never persisted
    // The returned summary carries only a masked hint, never the key.
    expect(summary?.keyHint).toBe("****1234");
    expect(JSON.stringify(summary)).not.toContain("sk-super-secret-1234");
  });

  it("the internal decrypt path round-trips the exact key", async () => {
    const stored = encryptSecret("anthropic-key-xyz-9999");
    mockSafeQuery.mockResolvedValue({ rows: [{ encrypted_key: stored }] });
    expect(await getDecryptedModelKey("w1", "anthropic")).toBe("anthropic-key-xyz-9999");
  });

  it("getDecryptedModelKey returns null when there is no key (fail-closed)", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    expect(await getDecryptedModelKey("w1", "azure")).toBeNull();
  });

  it("listModelKeys is leak-safe: a hint, never the key or the ciphertext", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [{ id: "k1", provider: "openai", label: "prod", key_hint: "****1234", created_at: "2026-09-17T00:00:00Z" }],
    });
    const list = await listModelKeys("w1");
    expect(list).toHaveLength(1);
    // Exactly the safe fields - no encrypted_key, no plaintext key.
    expect(Object.keys(list[0]).sort()).toEqual(["createdAt", "id", "keyHint", "label", "provider"]);
    expect(list[0].keyHint).toBe("****1234");
  });

  it("rejects an unknown provider before touching the database", async () => {
    await expect(
      setModelKey({ workspaceId: "w1", provider: "hackerllm" as never, plaintextKey: "x" }),
    ).rejects.toThrow(/unknown provider/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("emits an analytics event that never carries the key value", async () => {
    await setModelKey({ workspaceId: "w1", provider: "openai", plaintextKey: "sk-secret-0000", createdBy: "u1" });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "ai_code.model_key_set", "u1", "agent",
      expect.objectContaining({ workspace_id: "w1", provider: "openai" }),
    );
    const props = JSON.stringify(mockTrackEvent.mock.calls[0][3]);
    expect(props).not.toContain("sk-secret-0000");
  });
});
