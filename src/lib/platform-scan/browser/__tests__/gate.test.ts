/**
 * The gate-fronted browser-action authorizer is the model-agnostic safety
 * contract every AI browser driver must call before touching a client system, so
 * every floor is pinned here: the read-only floor (observation needs no scope),
 * the mutation floor (click/fill/submit need an active ui_probe scope + a gate
 * allow), and the defense-in-depth ordering (kill switch -> ownership -> SSRF ->
 * scope -> gate). SsrfBlockedError is kept real (requireActual) so the gate's
 * instanceof check is exercised, not mocked away. Mirrors guard.test.ts.
 */
const mockGetActiveScope = jest.fn();
const mockAuthorize = jest.fn();
const mockAssertScannable = jest.fn();
const mockTrack = jest.fn();
const mockRecordAudit = jest.fn();
const mockIsCurated = jest.fn(() => true);
const mockIsVerified = jest.fn(async () => true);

jest.mock("@/lib/platform-scan/pentest/scope", () => ({
  getActiveScope: (...a: unknown[]) => mockGetActiveScope(...a),
}));
jest.mock("@/lib/ogiam/authorize", () => ({ authorize: (...a: unknown[]) => mockAuthorize(...a) }));
jest.mock("@/lib/platform-scan/ssrf-guard", () => {
  const actual = jest.requireActual("@/lib/platform-scan/ssrf-guard");
  return { ...actual, assertScannableUrl: (...a: unknown[]) => mockAssertScannable(...a) };
});
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockRecordAudit(...a) }));
jest.mock("@/lib/platform-scan/manifests", () => ({ isCuratedTarget: (...a: unknown[]) => mockIsCurated(...(a as [])) }));
jest.mock("@/lib/platform-scan/authorization", () => ({ isTargetVerified: (...a: unknown[]) => mockIsVerified(...(a as [])) }));

import { authorizeBrowserAction, isMutatingAction, type BrowserAction } from "@/lib/platform-scan/browser/gate";
import { SsrfBlockedError } from "@/lib/platform-scan/ssrf-guard";

const ACTOR = { userId: "u1", role: "admin" };
const HOST = "wolfpack-auto.vercel.app";
const URL_OK = `https://${HOST}/admin/leads`;

function navigate(over: Partial<BrowserAction> = {}): BrowserAction {
  return { kind: "navigate", targetUrl: URL_OK, platform: "wolfpack-auto", ...over };
}
function click(over: Partial<BrowserAction> = {}): BrowserAction {
  return { kind: "click", targetUrl: URL_OK, platform: "wolfpack-auto", selector: "#go", ...over };
}

const uiProbeScope = {
  id: "scope-1",
  platform: "wolfpack-auto",
  allowedHosts: [HOST],
  allowedTechniques: ["ui_probe"],
  maxRequests: 100,
  requestsUsed: 0,
  expiresAt: "2099-01-01T00:00:00.000Z",
  status: "active",
};

const ORIGINAL_KILL = process.env.PENTEST_KILL_SWITCH;
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.PENTEST_KILL_SWITCH;
  mockGetActiveScope.mockResolvedValue(uiProbeScope);
  mockAssertScannable.mockResolvedValue(undefined);
  mockAuthorize.mockResolvedValue({ effectiveOutcome: "allow", ruleId: "r", reason: "ok", enforced: true });
  mockIsCurated.mockReturnValue(true);
  mockIsVerified.mockResolvedValue(true);
  mockRecordAudit.mockResolvedValue({ id: "a", seq: 1, entryHash: "h" });
});
afterEach(() => {
  if (ORIGINAL_KILL === undefined) delete process.env.PENTEST_KILL_SWITCH;
  else process.env.PENTEST_KILL_SWITCH = ORIGINAL_KILL;
});

describe("isMutatingAction (the action model)", () => {
  it("classifies navigate/observe/hover/key as read-only by default", () => {
    for (const kind of ["navigate", "observe", "hover", "key"] as const) {
      expect(isMutatingAction({ kind, targetUrl: URL_OK, platform: "p" })).toBe(false);
    }
  });
  it("classifies click/fill/submit as mutating", () => {
    for (const kind of ["click", "fill", "submit"] as const) {
      expect(isMutatingAction({ kind, targetUrl: URL_OK, platform: "p" })).toBe(true);
    }
  });
  it("up-classifies a read-only kind when mutating === true (flag can never down-classify)", () => {
    expect(isMutatingAction({ kind: "navigate", targetUrl: URL_OK, platform: "p", mutating: true })).toBe(true);
    expect(isMutatingAction({ kind: "click", targetUrl: URL_OK, platform: "p", mutating: false })).toBe(true);
  });
});

describe("read-only floor (the safe default tier)", () => {
  it("allows a read-only navigate on a verified target with NO scope", async () => {
    mockIsCurated.mockReturnValue(false);
    mockIsVerified.mockResolvedValue(true);
    mockGetActiveScope.mockResolvedValue(null); // no scope at all
    const res = await authorizeBrowserAction({ workspaceId: "ws-1", action: navigate(), actor: ACTOR });
    expect(res.allowed).toBe(true);
    expect(mockGetActiveScope).not.toHaveBeenCalled(); // read-only skips the scope floor
    // Read-only runs the gate in MONITOR (observed + audited, never blocked).
    expect(mockAuthorize).toHaveBeenCalledWith(expect.objectContaining({ mode: "monitor", isMutation: false }));
  });
  it("allows a read-only observe on a CURATED target without verification", async () => {
    mockIsCurated.mockReturnValue(true);
    mockIsVerified.mockResolvedValue(false); // would block a client target; curated is exempt
    const res = await authorizeBrowserAction({ workspaceId: "ws-1", action: navigate({ kind: "observe" }), actor: ACTOR });
    expect(res.allowed).toBe(true);
  });
  it("allows read-only even when the gate would not say allow (monitor never blocks)", async () => {
    mockAuthorize.mockResolvedValue({ effectiveOutcome: "monitor", ruleId: "r", reason: "ok", enforced: false });
    const res = await authorizeBrowserAction({ workspaceId: "ws-1", action: navigate(), actor: ACTOR });
    expect(res.allowed).toBe(true);
  });
});

describe("mutation floor (scope + gate required)", () => {
  it("blocks a mutating click when there is NO active scope", async () => {
    mockGetActiveScope.mockResolvedValue(null);
    const res = await authorizeBrowserAction({ workspaceId: "ws-1", action: click(), actor: ACTOR });
    expect(res).toEqual({ allowed: false, reason: "no_active_scope" });
    expect(mockAuthorize).not.toHaveBeenCalled(); // never reaches the gate
  });
  it("blocks a mutating click when ui_probe is not in the scope techniques", async () => {
    mockGetActiveScope.mockResolvedValue({ ...uiProbeScope, allowedTechniques: ["idor"] });
    const res = await authorizeBrowserAction({ workspaceId: "ws-1", action: click(), actor: ACTOR });
    expect(res).toEqual({ allowed: false, reason: "ui_probe_not_in_scope" });
  });
  it("blocks a mutating click when the host is not in the scope allowlist", async () => {
    mockGetActiveScope.mockResolvedValue({ ...uiProbeScope, allowedHosts: ["other.example.com"] });
    const res = await authorizeBrowserAction({ workspaceId: "ws-1", action: click(), actor: ACTOR });
    expect(res).toEqual({ allowed: false, reason: "host_not_in_scope" });
  });
  it("allows a mutating click WITH a ui_probe scope + gate allow (enforce mode)", async () => {
    const res = await authorizeBrowserAction({ workspaceId: "ws-1", action: click(), actor: ACTOR });
    expect(res.allowed).toBe(true);
    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "platform.pentest", mode: "enforce", isMutation: true, tool: "browser.action" }),
    );
  });
  it("matches the scope host case-insensitively (admin typed mixed case)", async () => {
    mockGetActiveScope.mockResolvedValue({ ...uiProbeScope, allowedHosts: ["WolfPack-Auto.Vercel.App"] });
    const res = await authorizeBrowserAction({ workspaceId: "ws-1", action: click(), actor: ACTOR });
    expect(res.allowed).toBe(true);
  });
  it("blocks a mutating click when the OGIAM gate denies (enforce)", async () => {
    mockAuthorize.mockResolvedValue({ effectiveOutcome: "deny", ruleId: "deny-rule", reason: "no policy", enforced: true });
    const res = await authorizeBrowserAction({ workspaceId: "ws-1", action: click(), actor: ACTOR });
    expect(res).toEqual({ allowed: false, reason: "gate_denied" });
  });
});

describe("defense-in-depth floors", () => {
  it("blocks on the kill switch before anything else is consulted", async () => {
    process.env.PENTEST_KILL_SWITCH = "on";
    const res = await authorizeBrowserAction({ workspaceId: "ws-1", action: click(), actor: ACTOR });
    expect(res).toEqual({ allowed: false, reason: "kill_switch" });
    expect(mockIsVerified).not.toHaveBeenCalled();
    expect(mockGetActiveScope).not.toHaveBeenCalled();
    expect(mockAuthorize).not.toHaveBeenCalled();
  });
  it("blocks an unverified, non-curated client target", async () => {
    mockIsCurated.mockReturnValue(false);
    mockIsVerified.mockResolvedValue(false);
    const res = await authorizeBrowserAction({ workspaceId: "ws-1", action: navigate({ platform: "acme-crm" }), actor: ACTOR });
    expect(res).toEqual({ allowed: false, reason: "unverified_target" });
    expect(mockAuthorize).not.toHaveBeenCalled();
  });
  it("blocks an SSRF target even on a read-only action", async () => {
    mockAssertScannable.mockRejectedValue(new SsrfBlockedError("private IP"));
    const res = await authorizeBrowserAction({
      workspaceId: "ws-1",
      action: navigate({ targetUrl: "http://169.254.169.254/" }),
      actor: ACTOR,
    });
    expect(res).toEqual({ allowed: false, reason: "ssrf_blocked" });
    expect(mockAuthorize).not.toHaveBeenCalled();
  });
});

describe("analytics + audit on every decision", () => {
  it("fires browser_action_allowed and records an audit entry on allow", async () => {
    await authorizeBrowserAction({ workspaceId: "ws-1", action: click(), actor: ACTOR });
    expect(mockTrack).toHaveBeenCalledWith(
      "platform.browser_action_allowed",
      "u1",
      "admin",
      expect.objectContaining({ platform: "wolfpack-auto", action: "click" }),
    );
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "platform.browser_action.allowed", resourceType: "browser_action" }),
    );
  });
  it("fires browser_action_blocked with the reason and records an audit entry on block", async () => {
    mockGetActiveScope.mockResolvedValue(null);
    await authorizeBrowserAction({ workspaceId: "ws-1", action: click(), actor: ACTOR });
    expect(mockTrack).toHaveBeenCalledWith(
      "platform.browser_action_blocked",
      "u1",
      "admin",
      expect.objectContaining({ action: "click", reason: "no_active_scope" }),
    );
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "platform.browser_action.blocked" }),
    );
  });
  it("does not throw when recordAudit fails (the decision is still returned)", async () => {
    mockRecordAudit.mockRejectedValue(new Error("chain write failed"));
    const res = await authorizeBrowserAction({ workspaceId: "ws-1", action: navigate(), actor: ACTOR });
    expect(res.allowed).toBe(true);
  });
});
