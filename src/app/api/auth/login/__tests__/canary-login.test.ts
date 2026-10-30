/** @jest-environment node */
/**
 * Instinct's own sign-in records a planted canary username, then fails exactly
 * like a wrong password (same status and body), so the trap is never revealed.
 * A real username is never checked against the canary registry.
 */
import { NextRequest } from "next/server";
const mockAuth = jest.fn(); const mockReport = jest.fn(async () => true);
jest.mock("@/lib/auth", () => ({ authenticate: (...a: unknown[]) => mockAuth(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));
jest.mock("@/lib/audit-log", () => ({ recordAudit: jest.fn(async () => {}), extractRequestMetadata: () => ({}) }));
jest.mock("@/lib/crypto/refresh-tokens", () => ({ issueRefreshToken: jest.fn() }));
jest.mock("@/lib/forcefield/canary-trip", () => ({ reportCanarySignIn: (...a: unknown[]) => mockReport(...(a as [])) }));
import { POST } from "../route";

const req = (email: string, ip: string) => new NextRequest("http://x/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ email, password: "whatever" }) });
beforeEach(() => { jest.clearAllMocks(); mockAuth.mockResolvedValue(null); });

it("a canary username (or canary@domain) is recorded and fails like any wrong password", async () => {
  const wrong = await POST(req("someone@example.com", "10.0.0.1"));
  const canary = await POST(req("svc_backup_k7q2m3", "10.0.0.2"));
  const canaryEmail = await POST(req("svc_backup_k7q2m3@ogiam.com", "10.0.0.3"));
  for (const r of [canary, canaryEmail]) {
    expect(r.status).toBe(wrong.status);
    expect(await r.json()).toEqual({ error: "Invalid credentials" });
  }
  expect(mockReport).toHaveBeenCalledTimes(2);
  expect(mockReport).toHaveBeenCalledWith({ site: "instinct", username: "svc_backup_k7q2m3", path: "/api/auth/login" });
});

it("a real sign-in never touches the canary registry", async () => {
  await POST(req("alice@example.com", "10.0.0.4"));
  expect(mockReport).not.toHaveBeenCalled();
});
