/** @jest-environment node */
/**
 * Non-interactive factory auth. The service token must be fail-closed (off until a
 * real secret is set, constant-time compared) and must otherwise behave EXACTLY
 * like today's user auth (fall through to requireCapability).
 */
import { factoryTokenMatches, factoryServiceAuth } from "@/lib/ai-code/factory-service-auth";

const TOKEN = "a".repeat(32);
const req = (token: string | null) => ({ headers: { get: (k: string) => (k === "x-factory-token" ? token : null) } }) as never;

const origEnv = process.env.FACTORY_SERVICE_TOKEN;
afterEach(() => {
  if (origEnv === undefined) delete process.env.FACTORY_SERVICE_TOKEN;
  else process.env.FACTORY_SERVICE_TOKEN = origEnv;
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

describe("factoryServiceAuth", () => {
  it("with a valid token: a scoped service identity, only factory caps, least privilege", () => {
    process.env.FACTORY_SERVICE_TOKEN = TOKEN;
    const r = factoryServiceAuth(req(TOKEN));
    expect(r).not.toBeNull();
    if (r && r.ok) {
      expect(r.user.id).toBe("instinct.ai_code.service");
      expect(r.user.workspaceId).toBe("default");
      expect(r.capabilities.has("settings.manage_team")).toBe(true);
      expect(r.capabilities.has("analytics.triage")).toBe(true);
      expect(r.capabilities.has("mail.send" as never)).toBe(false);
    }
  });
  it("no token -> null (route falls through to requireCapability)", () => {
    process.env.FACTORY_SERVICE_TOKEN = TOKEN;
    expect(factoryServiceAuth(req(null))).toBeNull();
  });
  it("wrong token -> null (never the service identity)", () => {
    process.env.FACTORY_SERVICE_TOKEN = TOKEN;
    expect(factoryServiceAuth(req("wrong".repeat(8)))).toBeNull();
  });
});
