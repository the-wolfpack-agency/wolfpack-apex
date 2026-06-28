/**
 * Unit tests for the external gate API-key library.
 *
 * Mocks the DB (an in-memory row store) and uses REAL crypto so the security
 * guarantees are exercised end-to-end:
 *   - createApiKey returns a plaintext but stores only a sha256 hash (the
 *     stored value is NOT the plaintext).
 *   - verifyApiKey returns the EXACT typed contract the gate depends on:
 *       valid -> { ok, id, workspaceId, agent, capabilities }
 *       wrong key -> not_found
 *       revoked -> revoked
 *       malformed -> malformed
 *   - the constant-time hash-compare path is exercised (a key whose prefix
 *     collides but whose body differs is rejected as not_found).
 *   - revoke then verify -> revoked.
 *   - listApiKeys returns masked rows and never leaks the hash or plaintext.
 */

export {};

import { createHash } from "node:crypto";

/* ---- in-memory DB mock ---------------------------------------------------- */

interface Row {
  id: string;
  workspace_id: string;
  agent: string;
  key_hash: string;
  key_prefix: string;
  last4: string | null;
  capabilities: string[];
  created_by: string | null;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

let store: Row[] = [];
let throwOnNextQuery = false;

const mockQuery = jest.fn(async (text: string, params: unknown[] = []) => {
  if (throwOnNextQuery) {
    throwOnNextQuery = false;
    throw new Error("simulated db outage");
  }
  const sql = text.replace(/\s+/g, " ").trim().toUpperCase();

  if (sql.startsWith("INSERT INTO INSTINCT_GATE_API_KEYS")) {
    const [id, workspace_id, agent, key_hash, key_prefix, last4, capabilities, created_by] =
      params as [string, string, string, string, string, string, string[], string];
    store.push({
      id,
      workspace_id,
      agent,
      key_hash,
      key_prefix,
      last4,
      capabilities,
      created_by,
      created_at: new Date().toISOString(),
      revoked_at: null,
      last_used_at: null,
    });
    return { rows: [], rowCount: 1 };
  }

  if (sql.startsWith("SELECT") && sql.includes("WHERE KEY_PREFIX")) {
    const prefix = params[0] as string;
    const rows = store
      .filter((r) => r.key_prefix === prefix)
      .map((r) => ({
        id: r.id,
        workspace_id: r.workspace_id,
        agent: r.agent,
        key_hash: r.key_hash,
        capabilities: r.capabilities,
        revoked_at: r.revoked_at,
      }));
    return { rows, rowCount: rows.length };
  }

  if (sql.startsWith("UPDATE") && sql.includes("LAST_USED_AT = NOW()") && !sql.includes("REVOKED_AT")) {
    const id = params[0] as string;
    const row = store.find((r) => r.id === id);
    if (row) row.last_used_at = new Date().toISOString();
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  if (sql.startsWith("UPDATE") && sql.includes("SET REVOKED_AT = NOW()")) {
    const [id, workspace_id] = params as [string, string];
    const row = store.find(
      (r) => r.id === id && r.workspace_id === workspace_id && r.revoked_at === null,
    );
    if (row) row.revoked_at = new Date().toISOString();
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  if (sql.startsWith("SELECT") && sql.includes("WHERE WORKSPACE_ID")) {
    const workspace_id = params[0] as string;
    const rows = store
      .filter((r) => r.workspace_id === workspace_id)
      .map((r) => ({ ...r }));
    return { rows, rowCount: rows.length };
  }

  throw new Error(`unhandled query in mock: ${sql}`);
});

jest.mock("@/lib/db", () => ({
  query: (...a: any[]) => mockQuery(...(a as [string, unknown[]])),
}));

import {
  createApiKey,
  verifyApiKey,
  revokeApiKey,
  listApiKeys,
} from "@/lib/ogiam/api-keys";

beforeEach(() => {
  store = [];
  throwOnNextQuery = false;
  mockQuery.mockClear();
});

describe("createApiKey", () => {
  it("returns a plaintext key in the ogk_ format with prefix + last4", async () => {
    const out = await createApiKey({
      workspaceId: "ws_a",
      agent: "acme.qa-bot",
      capabilities: ["mail.read"],
      createdBy: "u_cto",
    });
    expect(out.plaintextKey).toMatch(/^ogk_[A-Za-z0-9_-]+$/);
    expect(out.prefix).toBe(out.plaintextKey.slice(0, "ogk_".length + 6));
    expect(out.last4).toBe(out.plaintextKey.slice(-4));
    expect(out.id).toMatch(/^gak_/);
  });

  it("stores ONLY the sha256 hash, never the plaintext", async () => {
    const out = await createApiKey({
      workspaceId: "ws_a",
      agent: "acme.qa-bot",
      capabilities: ["mail.read"],
      createdBy: "u_cto",
    });
    const row = store[0];
    expect(row.key_hash).not.toBe(out.plaintextKey);
    expect(row.key_hash).toBe(
      createHash("sha256").update(out.plaintextKey, "utf8").digest("hex"),
    );
    // No column anywhere holds the plaintext.
    for (const v of Object.values(row)) {
      expect(v).not.toBe(out.plaintextKey);
    }
  });

  it("normalises capabilities (trims, drops blanks, de-dupes)", async () => {
    await createApiKey({
      workspaceId: "ws_a",
      agent: "a",
      capabilities: [" mail.read ", "mail.read", "", "mail.send"],
      createdBy: "u",
    });
    expect(store[0].capabilities).toEqual(["mail.read", "mail.send"]);
  });
});

describe("verifyApiKey", () => {
  it("valid key -> ok with workspace, agent, capabilities (exact contract)", async () => {
    const out = await createApiKey({
      workspaceId: "ws_a",
      agent: "acme.qa-bot",
      capabilities: ["mail.read", "calendar.read"],
      createdBy: "u_cto",
    });
    const res = await verifyApiKey(out.plaintextKey);
    expect(res).toEqual({
      ok: true,
      id: out.id,
      workspaceId: "ws_a",
      agent: "acme.qa-bot",
      capabilities: ["mail.read", "calendar.read"],
    });
  });

  it("updates last_used_at best-effort on a valid verify", async () => {
    const out = await createApiKey({
      workspaceId: "ws_a",
      agent: "a",
      capabilities: [],
      createdBy: "u",
    });
    await verifyApiKey(out.plaintextKey);
    // allow the fire-and-forget update to flush
    await new Promise((r) => setTimeout(r, 0));
    expect(store[0].last_used_at).not.toBeNull();
  });

  it("wrong key -> not_found", async () => {
    await createApiKey({
      workspaceId: "ws_a",
      agent: "a",
      capabilities: [],
      createdBy: "u",
    });
    const res = await verifyApiKey("ogk_totally-different-key-value-1234567890");
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });

  it("exercises the constant-time path: same prefix, different body -> not_found", async () => {
    const out = await createApiKey({
      workspaceId: "ws_a",
      agent: "a",
      capabilities: [],
      createdBy: "u",
    });
    // Craft a forgery that shares the lookup prefix but has a different body, so
    // the row IS found by prefix and the FULL-hash constant-time compare must
    // reject it.
    const prefix = out.plaintextKey.slice(0, "ogk_".length + 6);
    const forged = `${prefix}ZZZZZZZZZZZZZZZZZZZZ`;
    expect(forged.slice(0, "ogk_".length + 6)).toBe(prefix);
    const res = await verifyApiKey(forged);
    expect(res).toEqual({ ok: false, reason: "not_found" });
    // Confirm the row really was a prefix candidate (the compare ran, not a miss).
    expect(store[0].key_prefix).toBe(prefix);
  });

  it("malformed (no ogk_ prefix) -> malformed", async () => {
    expect(await verifyApiKey("not-a-key")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("malformed (too short) -> malformed", async () => {
    expect(await verifyApiKey("ogk_ab")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("malformed (non-string) -> malformed", async () => {
    expect(await verifyApiKey(undefined as unknown as string)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await verifyApiKey(12345 as unknown as string)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("revoked key -> revoked", async () => {
    const out = await createApiKey({
      workspaceId: "ws_a",
      agent: "a",
      capabilities: [],
      createdBy: "u",
    });
    await revokeApiKey(out.id, "ws_a");
    const res = await verifyApiKey(out.plaintextKey);
    expect(res).toEqual({ ok: false, reason: "revoked" });
  });

  it("never throws: a DB error degrades to not_found (fails closed)", async () => {
    const out = await createApiKey({
      workspaceId: "ws_a",
      agent: "a",
      capabilities: [],
      createdBy: "u",
    });
    throwOnNextQuery = true;
    const res = await verifyApiKey(out.plaintextKey);
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("revokeApiKey", () => {
  it("revokes a live key in the same workspace", async () => {
    const out = await createApiKey({
      workspaceId: "ws_a",
      agent: "a",
      capabilities: [],
      createdBy: "u",
    });
    expect(await revokeApiKey(out.id, "ws_a")).toBe(true);
    expect(store[0].revoked_at).not.toBeNull();
  });

  it("is workspace-scoped: cannot revoke another workspace's key", async () => {
    const out = await createApiKey({
      workspaceId: "ws_a",
      agent: "a",
      capabilities: [],
      createdBy: "u",
    });
    expect(await revokeApiKey(out.id, "ws_b")).toBe(false);
    expect(store[0].revoked_at).toBeNull();
  });

  it("is idempotent: re-revoking returns false", async () => {
    const out = await createApiKey({
      workspaceId: "ws_a",
      agent: "a",
      capabilities: [],
      createdBy: "u",
    });
    expect(await revokeApiKey(out.id, "ws_a")).toBe(true);
    expect(await revokeApiKey(out.id, "ws_a")).toBe(false);
  });
});

describe("listApiKeys", () => {
  it("returns masked rows and NEVER leaks the hash or plaintext", async () => {
    const out = await createApiKey({
      workspaceId: "ws_a",
      agent: "acme.qa-bot",
      capabilities: ["mail.read"],
      createdBy: "u_cto",
    });
    const list = await listApiKeys("ws_a");
    expect(list).toHaveLength(1);
    const masked = list[0];
    expect(masked).toMatchObject({
      id: out.id,
      workspaceId: "ws_a",
      agent: "acme.qa-bot",
      prefix: out.prefix,
      last4: out.last4,
      capabilities: ["mail.read"],
      revoked: false,
    });
    // No hash / plaintext leakage anywhere in the serialized row.
    const serialized = JSON.stringify(masked);
    expect(serialized).not.toContain(out.plaintextKey);
    expect(serialized).not.toContain(store[0].key_hash);
    expect("key_hash" in masked).toBe(false);
  });

  it("is workspace-scoped: only the caller's workspace keys", async () => {
    await createApiKey({ workspaceId: "ws_a", agent: "a", capabilities: [], createdBy: "u" });
    await createApiKey({ workspaceId: "ws_b", agent: "b", capabilities: [], createdBy: "u" });
    const list = await listApiKeys("ws_a");
    expect(list).toHaveLength(1);
    expect(list[0].workspaceId).toBe("ws_a");
  });

  it("reflects revoked state", async () => {
    const out = await createApiKey({ workspaceId: "ws_a", agent: "a", capabilities: [], createdBy: "u" });
    await revokeApiKey(out.id, "ws_a");
    const list = await listApiKeys("ws_a");
    expect(list[0].revoked).toBe(true);
    expect(list[0].revokedAt).not.toBeNull();
  });
});
