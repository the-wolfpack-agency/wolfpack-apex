/**
 * credentials.ts tests — encrypted-at-rest round-trips, masking,
 * fallback semantics when DB or env are unavailable.
 */

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrack(...a),
}));

import {
  loadConnectorCredentials,
  saveConnectorCredentials,
  listConnectorCredentials,
} from "@/lib/assistant/connectors/credentials";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secret-storage";

const ORIGINAL_DB = process.env.DATABASE_URL;

beforeEach(() => {
  mockSafeQuery.mockReset();
  mockTrack.mockClear();
  process.env.DATABASE_URL = "postgres://test";
  process.env.INSTINCT_JWT_SECRET = "test-jwt-secret-32-bytes-or-more";
});

afterAll(() => {
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DB;
});

describe("loadConnectorCredentials", () => {
  test("returns null in shadow mode", async () => {
    delete process.env.DATABASE_URL;
    expect(await loadConnectorCredentials("default", "rest-default")).toBeNull();
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });

  test("returns null when no row exists", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    expect(await loadConnectorCredentials("default", "rest-default")).toBeNull();
  });

  test("decrypts the auth_header on return", async () => {
    const enc = encryptSecret("Bearer abc123xyz");
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          workspace_id: "default",
          connector_name: "rest-default",
          base_url: "https://api.acme.com/v2",
          auth_header_enc: enc,
          object_map_json: '{"deal":"opportunities"}',
          is_active: true,
        },
      ],
    });
    const r = await loadConnectorCredentials("default", "rest-default");
    expect(r).not.toBeNull();
    expect(r?.authHeader).toBe("Bearer abc123xyz");
    expect(r?.baseUrl).toBe("https://api.acme.com/v2");
    expect(r?.objectMap).toEqual({ deal: "opportunities" });
  });

  test("username_password: decodes username/password back + surfaces loginPath / cookie", async () => {
    const basic =
      "Basic " + Buffer.from("admin@beyond:s3cret-pw", "utf8").toString("base64");
    const enc = encryptSecret(basic);
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          workspace_id: "default",
          connector_name: "rest-default",
          base_url: "https://beyond.example.com",
          auth_header_enc: enc,
          object_map_json: null,
          is_active: true,
          auth_type: "username_password",
          access_token_expires_at: null,
          login_path: "/api/auth/login",
          session_cookie_name: "session",
        },
      ],
    });
    const r = await loadConnectorCredentials("default", "rest-default");
    expect(r).not.toBeNull();
    expect(r?.authType).toBe("username_password");
    /* The encrypted Basic header decrypts to the canonical form, AND the
       loader exposes the decoded credential pair for the connector to
       replay the form login. */
    expect(r?.authHeader).toBe(basic);
    expect(r?.username).toBe("admin@beyond");
    expect(r?.password).toBe("s3cret-pw");
    expect(r?.loginPath).toBe("/api/auth/login");
    expect(r?.sessionCookieName).toBe("session");
  });

  test("static_bearer rows do NOT expose username/password", async () => {
    const enc = encryptSecret("Bearer abc123xyz");
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          workspace_id: "default",
          connector_name: "rest-default",
          base_url: "https://api.acme.com/v2",
          auth_header_enc: enc,
          object_map_json: null,
          is_active: true,
          auth_type: "static_bearer",
          access_token_expires_at: null,
          login_path: null,
          session_cookie_name: null,
        },
      ],
    });
    const r = await loadConnectorCredentials("default", "rest-default");
    expect(r?.authType).toBe("static_bearer");
    expect(r?.username).toBeUndefined();
    expect(r?.password).toBeUndefined();
    expect(r?.loginPath).toBeUndefined();
  });

  test("returns null + fires decrypt-failed analytics when token can't be decrypted", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          workspace_id: "default",
          connector_name: "rest-default",
          base_url: "https://x",
          auth_header_enc: "v1.bad.token.value",
          object_map_json: null,
          is_active: true,
        },
      ],
    });
    const r = await loadConnectorCredentials("default", "rest-default");
    expect(r).toBeNull();
    expect(mockTrack).toHaveBeenCalledWith(
      "assistant.connector_credentials_decrypt_failed",
      "system",
      "system",
      expect.objectContaining({ connector: "rest-default" }),
    );
  });

  test("returns null on DB error (fail-closed)", async () => {
    mockSafeQuery.mockRejectedValueOnce(new Error("DB down"));
    expect(await loadConnectorCredentials("default", "rest-default")).toBeNull();
  });

  test("treats empty workspaceId as 'default'", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    await loadConnectorCredentials("", "rest-default");
    /* The first param to the SQL call is the SQL itself; the array
       of bound params is the second arg. */
    const params = mockSafeQuery.mock.calls[0][1] as string[];
    expect(params[0]).toBe("default");
  });
});

describe("saveConnectorCredentials", () => {
  test("encrypts auth_header before insert + emits analytics", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          workspace_id: "ws1",
          connector_name: "rest-default",
          base_url: "https://api.acme.com",
          object_map_json: null,
          is_active: true,
          created_at: "2026-05-14T12:00:00",
          updated_at: "2026-05-14T12:00:00",
        },
      ],
    });
    const r = await saveConnectorCredentials({
      workspaceId: "ws1",
      connectorName: "rest-default",
      baseUrl: "https://api.acme.com",
      authHeader: "Bearer 9876xyz1234",
      createdBy: "u1",
    });
    expect(r).not.toBeNull();
    expect(r?.authHeaderHint).toMatch(/Bearer \*\*\*\*[a-zA-Z0-9]{4}$/);
    /* Confirm the encrypted value was passed to safeQuery (not the
       plaintext). */
    const params = mockSafeQuery.mock.calls[0][1] as string[];
    expect(params[3]).toMatch(/^v1\./);
    expect(params[3]).not.toContain("Bearer");
    expect(mockTrack).toHaveBeenCalledWith(
      "assistant.connector_credentials_updated",
      "u1",
      "system",
      expect.objectContaining({ connector: "rest-default", workspace_id: "ws1" }),
    );
  });

  test("username_password: stores an ENCRYPTED Basic header + persists login_path / cookie", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          workspace_id: "ws1",
          connector_name: "rest-default",
          base_url: "https://beyond.example.com",
          object_map_json: null,
          is_active: true,
          created_at: "2026-06-19T12:00:00",
          updated_at: "2026-06-19T12:00:00",
          auth_type: "username_password",
          login_path: "/api/auth/login",
          session_cookie_name: "session",
        },
      ],
    });
    const r = await saveConnectorCredentials({
      workspaceId: "ws1",
      connectorName: "rest-default",
      baseUrl: "https://beyond.example.com",
      authType: "username_password",
      username: "admin@beyond",
      password: "s3cret-pw",
      loginPath: "/api/auth/login",
      sessionCookieName: "session",
      createdBy: "u1",
    });
    expect(r).not.toBeNull();
    expect(r?.authType).toBe("username_password");
    expect(r?.loginPath).toBe("/api/auth/login");
    expect(r?.sessionCookieName).toBe("session");

    /* The stored auth_header (param index 3) must be the ENCRYPTED Basic
       header — not plaintext, and never the raw password. */
    const params = mockSafeQuery.mock.calls[0][1] as string[];
    const storedEnc = params[3];
    expect(storedEnc).toMatch(/^v1\./);
    expect(storedEnc).not.toContain("s3cret-pw");
    expect(storedEnc).not.toContain("admin@beyond");
    /* Decrypting the stored value yields the canonical Basic header. */
    const expectedHeader =
      "Basic " + Buffer.from("admin@beyond:s3cret-pw", "utf8").toString("base64");
    expect(decryptSecret(storedEnc)).toBe(expectedHeader);

    /* auth_type / login_path / session_cookie_name bound to the insert. */
    expect(params[6]).toBe("username_password");
    expect(params[7]).toBe("/api/auth/login");
    expect(params[8]).toBe("session");

    /* The masked hint must NOT leak the password. */
    expect(r?.authHeaderHint).toMatch(/^Basic \*\*\*\*/);
    expect(JSON.stringify(r)).not.toContain("s3cret-pw");
  });

  test("username_password: returns null when password is missing (fail-closed)", async () => {
    const r = await saveConnectorCredentials({
      connectorName: "rest-default",
      baseUrl: "https://x",
      authType: "username_password",
      username: "admin",
      loginPath: "/api/auth/login",
    });
    expect(r).toBeNull();
    /* Never touched the DB with a half-formed row. */
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });

  test("returns null in shadow mode", async () => {
    delete process.env.DATABASE_URL;
    expect(
      await saveConnectorCredentials({
        connectorName: "rest-default",
        baseUrl: "x",
        authHeader: "y",
      }),
    ).toBeNull();
  });

  test("returns null on DB error", async () => {
    mockSafeQuery.mockRejectedValueOnce(new Error("boom"));
    expect(
      await saveConnectorCredentials({
        connectorName: "rest-default",
        baseUrl: "x",
        authHeader: "y",
      }),
    ).toBeNull();
  });
});

describe("listConnectorCredentials", () => {
  test("returns masked rows (never plaintext)", async () => {
    const enc1 = encryptSecret("Bearer alpha1234");
    const enc2 = encryptSecret("Basic beta5678");
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          workspace_id: "default",
          connector_name: "rest-default",
          base_url: "https://api.acme.com",
          auth_header_enc: enc1,
          object_map_json: null,
          is_active: true,
          created_at: "2026-05-14T12:00:00",
          updated_at: "2026-05-14T12:00:00",
        },
        {
          workspace_id: "default",
          connector_name: "hubspot",
          base_url: "https://api.hubapi.com",
          auth_header_enc: enc2,
          object_map_json: null,
          is_active: false,
          created_at: "2026-05-14T12:00:00",
          updated_at: "2026-05-14T12:00:00",
        },
      ],
    });
    const r = await listConnectorCredentials("default");
    expect(r).toHaveLength(2);
    expect(r[0].authHeaderHint).toBe("Bearer ****1234");
    expect(r[1].authHeaderHint).toBe("Basic ****5678");
    /* The plaintext must never appear in the masked output. */
    expect(JSON.stringify(r)).not.toContain("alpha1234");
    expect(JSON.stringify(r)).not.toContain("beta5678");
  });

  test("returns empty array in shadow mode", async () => {
    delete process.env.DATABASE_URL;
    expect(await listConnectorCredentials()).toEqual([]);
  });
});
