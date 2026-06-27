/**
 * Stored scan-target registry (the onboarding spine). validateScanTargetInput is
 * a PURE normalizer (no I/O), tested directly. The store fns (save/get/list/remove)
 * are tested with the db boundary mocked, asserting the upsert/select/soft-delete
 * SQL shape, the JSON-string manifest round-trip, and the null/empty paths.
 */
const mockWriteQuery = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/db", () => ({
  writeQuery: (...a: unknown[]) => mockWriteQuery(...a),
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));

import {
  validateScanTargetInput,
  saveScanTarget,
  getStoredScanTarget,
  listStoredTargets,
  removeScanTarget,
} from "@/lib/platform-scan/targets-store";
import type { ScanManifest } from "@/lib/platform-scan/manifests";

beforeEach(() => jest.clearAllMocks());

describe("validateScanTargetInput (pure)", () => {
  it("accepts a valid minimal input and sets manifest.baseUrl", () => {
    const r = validateScanTargetInput({ baseUrl: "https://acme.example.com", routes: [] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.baseUrl).toBe("https://acme.example.com");
      expect(r.manifest.routes).toEqual([]);
    }
  });

  it("accepts a full input and carries the static repo target", () => {
    const r = validateScanTargetInput({
      baseUrl: "https://acme.example.com",
      routes: [{ path: "/admin", journey: "j", auth: "required" }],
      static: { owner: "o", repo: "r", ref: "main", paths: ["a"] },
      apiEndpoints: [{ path: "/api/x", method: "GET", journey: "x", requiresAuth: true }],
      login: { connectorName: "acme", loginPath: "/api/auth/login", sessionCookieName: "session" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.static).toEqual({ owner: "o", repo: "r", ref: "main", paths: ["a"] });
      expect(r.manifest.apiEndpoints).toHaveLength(1);
      expect(r.manifest.login?.connectorName).toBe("acme");
      expect(r.manifest.routes).toHaveLength(1);
    }
  });

  it("rejects a non-object body with body_required", () => {
    expect(validateScanTargetInput(null)).toEqual({ ok: false, error: "body_required" });
    expect(validateScanTargetInput("nope")).toEqual({ ok: false, error: "body_required" });
    expect(validateScanTargetInput(42)).toEqual({ ok: false, error: "body_required" });
  });

  it("rejects a bad baseUrl with baseUrl_invalid", () => {
    expect(validateScanTargetInput({ baseUrl: "not a url", routes: [] })).toEqual({
      ok: false,
      error: "baseUrl_invalid",
    });
  });

  it("rejects a non-http(s) scheme with baseUrl_scheme", () => {
    expect(validateScanTargetInput({ baseUrl: "ftp://x", routes: [] })).toEqual({
      ok: false,
      error: "baseUrl_scheme",
    });
  });

  it("rejects a route whose path does not start with /", () => {
    const r = validateScanTargetInput({
      baseUrl: "https://acme.example.com",
      routes: [{ path: "admin", journey: "j", auth: "required" }],
    });
    expect(r).toEqual({ ok: false, error: "route_path_invalid" });
  });

  it("rejects a route auth that is not required/public", () => {
    const r = validateScanTargetInput({
      baseUrl: "https://acme.example.com",
      routes: [{ path: "/admin", journey: "j", auth: "maybe" }],
    });
    expect(r).toEqual({ ok: false, error: "route_auth_invalid" });
  });

  it("rejects a static target missing owner/repo with static_invalid", () => {
    expect(
      validateScanTargetInput({ baseUrl: "https://acme.example.com", routes: [], static: { owner: "o" } }),
    ).toEqual({ ok: false, error: "static_invalid" });
    expect(
      validateScanTargetInput({ baseUrl: "https://acme.example.com", routes: [], static: { repo: "r" } }),
    ).toEqual({ ok: false, error: "static_invalid" });
  });
});

const MANIFEST: ScanManifest = { baseUrl: "https://acme.example.com", routes: [] };

describe("saveScanTarget", () => {
  it("issues an INSERT ... ON CONFLICT (workspace_id, platform) DO UPDATE with manifest as jsonb", async () => {
    mockWriteQuery.mockResolvedValue({ rows: [] });
    await saveScanTarget("ws-1", "acme", MANIFEST, "user-1");

    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO instinct_scan_targets/);
    expect(sql).toMatch(/ON CONFLICT \(workspace_id, platform\) DO UPDATE/);
    expect(sql).toMatch(/\$3::jsonb/);
    expect(params[0]).toBe("ws-1");
    expect(params[1]).toBe("acme");
    expect(params[2]).toBe(JSON.stringify(MANIFEST));
    expect(params[3]).toBe("user-1");
  });
});

describe("getStoredScanTarget", () => {
  it("selects the active row and parses a JSON-string manifest into an object", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [{ platform: "acme", manifest: JSON.stringify(MANIFEST), is_active: true }],
    });
    const m = await getStoredScanTarget("ws-1", "acme");

    const [sql, params] = mockSafeQuery.mock.calls[0];
    expect(sql).toMatch(/is_active = true/);
    expect(params).toEqual(["ws-1", "acme"]);
    expect(m).toEqual(MANIFEST);
    expect(typeof m).toBe("object");
  });

  it("returns an already-object manifest unchanged", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [{ platform: "acme", manifest: MANIFEST, is_active: true }] });
    expect(await getStoredScanTarget("ws-1", "acme")).toEqual(MANIFEST);
  });

  it("returns null when no row exists", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    expect(await getStoredScanTarget("ws-1", "missing")).toBeNull();
  });
});

describe("listStoredTargets", () => {
  it("maps rows, parsing each JSON-string manifest", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [
        { platform: "acme", manifest: JSON.stringify(MANIFEST), is_active: true },
        { platform: "beta", manifest: { baseUrl: "https://beta.example.com", routes: [] }, is_active: true },
      ],
    });
    const rows = await listStoredTargets("ws-1");

    expect(mockSafeQuery.mock.calls[0][1]).toEqual(["ws-1"]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ platform: "acme", manifest: MANIFEST });
    expect(rows[1].manifest.baseUrl).toBe("https://beta.example.com");
  });

  it("returns an empty array when no rows", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    expect(await listStoredTargets("ws-1")).toEqual([]);
  });
});

describe("removeScanTarget", () => {
  it("soft-removes (is_active = false) via UPDATE ... RETURNING and returns true when a row matched", async () => {
    mockWriteQuery.mockResolvedValue({ rows: [{ platform: "acme" }] });
    const removed = await removeScanTarget("ws-1", "acme");

    const [sql, params] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE instinct_scan_targets/);
    expect(sql).toMatch(/is_active = false/);
    expect(sql).toMatch(/RETURNING/);
    expect(params).toEqual(["ws-1", "acme"]);
    expect(removed).toBe(true);
  });

  it("returns false when no active row matched", async () => {
    mockWriteQuery.mockResolvedValue({ rows: [] });
    expect(await removeScanTarget("ws-1", "missing")).toBe(false);
  });
});
