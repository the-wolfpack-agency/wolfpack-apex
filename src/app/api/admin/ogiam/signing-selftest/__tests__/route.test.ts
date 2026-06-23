/**
 * Contract tests for POST /api/admin/ogiam/signing-selftest. Covers the auth
 * gate, the disabled and configured paths, the rate limit, that no secret leaks
 * into the response, and that the action is audited.
 */

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));

const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.1.1.1", userAgent: "test", requestId: "r" }),
}));

jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

const mockGetSigner = jest.fn();
const mockRunSelfTest = jest.fn();
const mockReadKv = jest.fn();
jest.mock("@/lib/ogiam/signing", () => ({
  getSigner: () => mockGetSigner(),
  runSignerSelfTest: (...a: unknown[]) => mockRunSelfTest(...a),
  readKeyVaultConfig: () => mockReadKv(),
}));

import { POST, _resetRateLimit } from "@/app/api/admin/ogiam/signing-selftest/route";

function req() {
  return { headers: { get: () => null } } as unknown as Parameters<typeof POST>[0];
}

const okAuth = { ok: true, user: { id: "u1", role: "cto", workspaceId: "ws-1" } };

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimit();
  mockReadKv.mockReturnValue(null);
});

it("401s when the capability is denied", async () => {
  mockRequireCapability.mockResolvedValue({
    ok: false,
    response: new Response("no", { status: 401 }),
  });
  const res = await POST(req());
  expect(res.status).toBe(401);
});

it("reports disabled when no signer is configured", async () => {
  mockRequireCapability.mockResolvedValue(okAuth);
  mockGetSigner.mockReturnValue({ mode: "none" });
  mockRunSelfTest.mockResolvedValue({
    mode: "none", isProduction: false, signed: false, verified: false, keyId: "", algorithm: "none", latencyMs: 1,
  });
  const res = await POST(req());
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body.ok).toBe(false);
  expect(body.mode).toBe("none");
  expect(body.env_present).toEqual(
    expect.objectContaining({ OGIAM_KEYVAULT_URL: expect.any(Boolean) }),
  );
});

it("reports ok when the round trip signs and verifies, and audits the action", async () => {
  mockRequireCapability.mockResolvedValue(okAuth);
  mockReadKv.mockReturnValue({});
  mockGetSigner.mockReturnValue({ mode: "keyvault" });
  mockRunSelfTest.mockResolvedValue({
    mode: "keyvault", isProduction: true, signed: true, verified: true,
    keyId: "https://v.vault.azure.net/keys/ogiam/abc", algorithm: "ES256", latencyMs: 42,
  });
  const res = await POST(req());
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.verified).toBe(true);
  expect(body.is_production).toBe(true);
  // The action is audited as security-relevant.
  expect(mockRecordAudit).toHaveBeenCalledWith(
    expect.objectContaining({ action: "ogiam.signing_selftest", resourceType: "ogiam_signer" }),
  );
});

it("never leaks a secret or signature bytes in the response", async () => {
  mockRequireCapability.mockResolvedValue(okAuth);
  mockGetSigner.mockReturnValue({ mode: "keyvault" });
  mockRunSelfTest.mockResolvedValue({
    mode: "keyvault", isProduction: true, signed: true, verified: true,
    keyId: "https://v.vault.azure.net/keys/ogiam/abc", algorithm: "ES256", latencyMs: 5,
  });
  const res = await POST(req());
  const text = JSON.stringify(await res.json());
  // No raw signature bytes, no env values, no client secret field.
  expect(text).not.toMatch(/signature/i);
  expect(text).not.toMatch(/client_secret|AZURE_CLIENT_SECRET":\s*"[^"]/);
});

it("rate limits after the window cap", async () => {
  mockRequireCapability.mockResolvedValue(okAuth);
  mockGetSigner.mockReturnValue({ mode: "none" });
  mockRunSelfTest.mockResolvedValue({
    mode: "none", isProduction: false, signed: false, verified: false, keyId: "", algorithm: "none", latencyMs: 1,
  });
  let last: Response | undefined;
  for (let i = 0; i < 8; i++) last = await POST(req());
  expect(last!.status).toBe(429);
});
