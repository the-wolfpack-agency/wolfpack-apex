/** @jest-environment node */
/**
 * Non-interactive factory auth. The service token must be fail-closed (off until a
 * real secret is set, constant-time compared) and must otherwise behave EXACTLY
 * like today's user auth (fall through to requireCapability).
 */
const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));

import { factoryTokenMatches, requireFactoryServiceOrCapability } from "@/lib/ai-code/factory-service-auth";

const TOKEN = "a".repeat(32);
const req = (token: string | null) => ({ headers: { get: (k: string) => (k === "x-factory-token" ? token : null) } }) as never;

const origEnv = process.env.FACTORY_SERVICE_TOKEN;
afterEach(() => {
  if (origEnv === undefined) delete process.env.FACTORY_SERVICE_TOKEN;
  else process.env.FACTORY_SERVICE_TOKEN = origEnv;
  jest.clearAllMocks();
});

describe("factoryTokenMatches (fail-closed)", () => {
  it("never matches when no secret is configured (service path OFF by default)", () => {
    delete process.env.FACTORY_SERVICE_TOKEN;
    expect(factoryTokenMatches(TOKEN)).toBe(false);
  });
  it("never matches a too-short secret (guards a weak/placeholder value)", () => {
    process.env.FACTORY_SERVICE_TOKEN = "short";
    expect(factoryTokenMatches("short")).toBe(false);
  });
  it("matches the exact token, rejects a wrong one", () => {
    process.env.FACTORY_SERVICE_TOKEN = TOKEN;
    expect(factoryTokenMatches(TOKEN)).toBe(true);
    expect(factoryTokenMatches("b".repeat(32))).toBe(false);
    expect(factoryTokenMatches(null)).toBe(false);
  });
});

describe("requireFactoryServiceOrCapability", () => {
  it("with a valid token: a scoped service identity, no user login, only factory caps", async () => {
    process.env.FACTORY_SERVICE_TOKEN = TOKEN;
    const r = await requireFactoryServiceOrCapability(req(TOKEN), "settings.manage_team");
    expect(mockRequireCapability).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.user.id).toBe("instinct.ai_code.service");
      expect(r.user.workspaceId).toBe("default");
      expect(r.capabilities.has("settings.manage_team")).toBe(true);
      expect(r.capabilities.has("analytics.triage")).toBe(true);
      // least privilege: a non-factory capability is NOT granted
      expect(r.capabilities.has("mail.send" as never)).toBe(false);
    }
  });
  it("no token: falls through to normal user capability auth, unchanged", async () => {
    process.env.FACTORY_SERVICE_TOKEN = TOKEN;
    mockRequireCapability.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
    const r = await requireFactoryServiceOrCapability(req(null), "settings.manage_team");
    expect(mockRequireCapability).toHaveBeenCalledWith(expect.anything(), "settings.manage_team");
    expect(r.ok).toBe(false);
  });
  it("wrong token: falls through to user auth (never the service identity)", async () => {
    process.env.FACTORY_SERVICE_TOKEN = TOKEN;
    mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1" }, capabilities: new Set() });
    const r = await requireFactoryServiceOrCapability(req("wrong".repeat(8)), "settings.manage_team");
    expect(mockRequireCapability).toHaveBeenCalled();
    if (r.ok) expect(r.user.id).toBe("u1");
  });
});
