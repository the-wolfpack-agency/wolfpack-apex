/**
 * GET /api/cron/audit-log-verify — scheduled compliance-chain verification.
 * Pins:
 *   - a valid chain → 200 { valid:true }, audit.chain_verified tracked, no alert
 *   - an INVALID chain → 200 { valid:false } + critical-priority notify + the
 *     existing tamper event
 *   - the cron bearer path runs without a session
 *   - no auth (no bearer, no capability) → 401/403, verifyChain not called
 *   - a thrown verifyChain is swallowed to a zeroed 200 (never 500)
 */
const mockVerifyChain = jest.fn();
const mockRequireCapability = jest.fn();
const mockEffectiveCaps = jest.fn();
const mockTrackEvent = jest.fn();
const mockNotify = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/audit-log", () => ({
  verifyChain: (...a: unknown[]) => mockVerifyChain(...a),
}));
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
  effectiveCapabilitiesFor: (...a: unknown[]) => mockEffectiveCaps(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/notifications/in-app", () => ({
  notify: (...a: unknown[]) => mockNotify(...a),
}));
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/cron/audit-log-verify/route";

const SECRET = "cron-secret-xyz";
function get(headers: Record<string, string> = {}) {
  return new NextRequest("https://x.test/api/cron/audit-log-verify", { headers });
}

let savedSecret: string | undefined;
beforeAll(() => {
  savedSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;
});
afterAll(() => {
  if (savedSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = savedSecret;
});
beforeEach(() => {
  jest.clearAllMocks();
  // Default: one active admin who holds settings.manage_team.
  mockSafeQuery.mockResolvedValue({
    rows: [{ id: "admin-1", email: "a@x.test", name: "Admin", role: "cto", workspace_id: "ws-1" }],
  });
  mockEffectiveCaps.mockResolvedValue({ capabilities: new Set(["settings.manage_team"]) });
  mockNotify.mockResolvedValue({ id: "notif-1" });
});

it("valid chain via cron bearer → 200 { valid:true }, event tracked, no alert", async () => {
  mockVerifyChain.mockResolvedValue({ valid: true, checkedCount: 42 });

  const res = await GET(get({ authorization: `Bearer ${SECRET}` }));

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, valid: true, checked: 42 });
  // bearer bypasses the session gate
  expect(mockRequireCapability).not.toHaveBeenCalled();
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "audit.chain_verified",
    "cron",
    "system",
    expect.objectContaining({ valid: true, checked: 42 }),
  );
  // valid chain raises no tamper event and no alert
  expect(mockTrackEvent).not.toHaveBeenCalledWith(
    "system.audit_log_tamper_suspected",
    expect.anything(),
    expect.anything(),
    expect.anything(),
  );
  expect(mockNotify).not.toHaveBeenCalled();
});

it("INVALID chain → 200 { valid:false } + critical notify + tamper event", async () => {
  mockVerifyChain.mockResolvedValue({
    valid: false,
    brokenAt: 7,
    checkedCount: 6,
    reason: "entry_hash_mismatch",
  });

  const res = await GET(get({ authorization: `Bearer ${SECRET}` }));

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    ok: true,
    valid: false,
    brokenAt: 7,
    reason: "entry_hash_mismatch",
    checked: 6,
    alerted: 1,
  });

  // Both the always-on verified event and the failure-only tamper event fire.
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "audit.chain_verified",
    "cron",
    "system",
    expect.objectContaining({ valid: false, checked: 6 }),
  );
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "system.audit_log_tamper_suspected",
    "cron",
    "system",
    expect.objectContaining({ broken_at: 7, reason: "entry_hash_mismatch", checked_count: 6 }),
  );

  // Admin alerted at critical priority.
  expect(mockNotify).toHaveBeenCalledTimes(1);
  expect(mockNotify).toHaveBeenCalledWith(
    expect.objectContaining({
      userId: "admin-1",
      priority: "critical",
      source: "audit-log-verify",
    }),
  );
});

it("does not alert a teammate who lacks settings.manage_team", async () => {
  mockVerifyChain.mockResolvedValue({
    valid: false,
    brokenAt: 3,
    checkedCount: 2,
    reason: "prev_hash_mismatch",
  });
  mockEffectiveCaps.mockResolvedValue({ capabilities: new Set(["mail.read"]) });

  const res = await GET(get({ authorization: `Bearer ${SECRET}` }));

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, valid: false, alerted: 0 });
  expect(mockNotify).not.toHaveBeenCalled();
});

it("the user path requires settings.manage_team and runs on success", async () => {
  mockVerifyChain.mockResolvedValue({ valid: true, checkedCount: 1 });
  mockRequireCapability.mockResolvedValue({
    ok: true,
    user: { id: "u-1", role: "admin", workspaceId: "ws-1" },
  });

  const res = await GET(get());

  expect(mockRequireCapability).toHaveBeenCalledWith(expect.anything(), "settings.manage_team");
  expect(res.status).toBe(200);
  expect(mockVerifyChain).toHaveBeenCalled();
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "audit.chain_verified",
    "u-1",
    "admin",
    expect.objectContaining({ valid: true, checked: 1 }),
  );
});

it("refuses an unauthorized request (no bearer, no capability) and never verifies", async () => {
  mockRequireCapability.mockResolvedValue({
    ok: false,
    response: new Response(null, { status: 403 }),
  });

  const res = await GET(get());

  expect(res.status).toBe(403);
  expect(mockVerifyChain).not.toHaveBeenCalled();
  expect(mockNotify).not.toHaveBeenCalled();
});

it("never 500s: a thrown verifyChain returns a zeroed 200", async () => {
  mockVerifyChain.mockRejectedValue(new Error("db down"));

  const res = await GET(get({ authorization: `Bearer ${SECRET}` }));

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, valid: true, checked: 0, skipped: true });
});
