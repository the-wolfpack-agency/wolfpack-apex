/**
 * @jest-environment node
 *
 * Contract for POST /api/signup (public self-serve). signupTenant + checkRateLimit
 * mocked - no DB. Proves 201 on success, 400 on invalid input (not 500), 429 when
 * rate-limited, and that a bad JSON body is handled (delegates to validation).
 */
import { NextRequest } from "next/server";

const mockSignup = jest.fn();
const mockRateLimit = jest.fn();
jest.mock("@/lib/tenancy/signup", () => ({ signupTenant: (...a: unknown[]) => mockSignup(...a) }));
jest.mock("@/lib/ogiam/gate-rate-limit", () => ({ checkRateLimit: (...a: unknown[]) => mockRateLimit(...a) }));
const mockAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockAudit(...a) }));

import { POST } from "../route";

function post(body: unknown, raw = false): NextRequest {
  return new NextRequest("http://localhost/api/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.5" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRateLimit.mockResolvedValue({ ok: true, remaining: 5 });
  mockSignup.mockResolvedValue({ ok: true, tenantId: "t-acme-ab12", status: "pending_provision", provisioningEnabled: false, message: "Registered and queued." });
  mockAudit.mockResolvedValue(undefined);
});

it("201 on a successful signup, returning the tenant id + status", async () => {
  const res = await POST(post({ orgName: "Acme Inc", adminEmail: "a@acme.com" }));
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.tenantId).toBe("t-acme-ab12");
  expect(mockSignup).toHaveBeenCalledWith({ orgName: "Acme Inc", adminEmail: "a@acme.com" });
  // audited on success, with a system actor and NO email
  expect(mockAudit).toHaveBeenCalledTimes(1);
  const audit = mockAudit.mock.calls[0][0];
  expect(audit.actor).toEqual({ user_id: "self-serve", role: "system" });
  expect(audit.resourceId).toBe("t-acme-ab12");
  expect(JSON.stringify(audit)).not.toContain("acme.com");
});

it("400 on invalid input (not a 500)", async () => {
  mockSignup.mockResolvedValue({ ok: false, provisioningEnabled: false, error: "admin_email", message: "Enter a valid admin email." });
  const res = await POST(post({ orgName: "Acme", adminEmail: "nope" }));
  expect(res.status).toBe(400);
  expect(mockAudit).not.toHaveBeenCalled(); // only successful registrations are audited
});

it("429 when rate-limited, without touching signup", async () => {
  mockRateLimit.mockResolvedValue({ ok: false, remaining: 0 });
  const res = await POST(post({ orgName: "Acme", adminEmail: "a@acme.com" }));
  expect(res.status).toBe(429);
  expect(mockSignup).not.toHaveBeenCalled();
});

it("rate-limit key is scoped to the client IP", async () => {
  await POST(post({ orgName: "Acme", adminEmail: "a@acme.com" }));
  expect(mockRateLimit).toHaveBeenCalledWith("signup:203.0.113.5", expect.objectContaining({ limit: 5 }));
});

it("a malformed body does not 500 - it delegates to validation (400)", async () => {
  mockSignup.mockResolvedValue({ ok: false, provisioningEnabled: false, error: "org_name", message: "Enter your organization name." });
  const res = await POST(post("{not json", true));
  expect(res.status).toBe(400);
});
