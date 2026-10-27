/** @jest-environment node */
/**
 * The dashboard session minted by the confirmation link: signed through the
 * crypto registry, purpose-bound (a confirmation or unsubscribe token is not a
 * session, and a session is not an ingest token), resolves only an ACTIVE
 * tenant, and the resolver keeps the ingest-token path unchanged.
 */
process.env.INSTINCT_JWT_SECRET = process.env.INSTINCT_JWT_SECRET || "test-secret-0123456789abcdef0123456789abcd";
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn(), trackEventAwait: jest.fn(async () => {}) }));
jest.mock("@/lib/db", () => ({ query: jest.fn(), safeQuery: jest.fn(async () => ({ rows: [] })) }));

import { mintDashboardSession, readDashboardSession, resolveTenantCredential } from "@/lib/forcefield-web/dashboard-session";
import { mintConfirmToken, mintUnsubscribeToken } from "@/lib/forcefield-web/tenant-notify";
import { signToken } from "@/lib/crypto/sign";

const TID = "6f1d0c2a-1111-4222-8333-944455556666";
const tenant = { id: TID, name: "acme", siteLabel: "acme.com", status: "active" as const, createdAt: "x" };

describe("dashboard session", () => {
  it("round-trips the tenant id", () => {
    expect(readDashboardSession(mintDashboardSession(TID))).toBe(TID);
  });

  it("refuses other purposes, expired sessions, garbage and ingest tokens", () => {
    expect(readDashboardSession(mintConfirmToken(TID, "qa@thewolfpack.agency"))).toBeNull();
    expect(readDashboardSession(mintUnsubscribeToken(TID, "qa@thewolfpack.agency"))).toBeNull();
    expect(readDashboardSession(signToken({ p: "ff_dashboard", t: TID }, { ttlSeconds: -10 }))).toBeNull();
    expect(readDashboardSession("not.a.jwt")).toBeNull();
    expect(readDashboardSession("ff_abc")).toBeNull();
    expect(readDashboardSession("")).toBeNull();
  });
});

describe("resolveTenantCredential", () => {
  it("an ingest token resolves by hash (via ingest); a session by signature (via session)", async () => {
    const byToken = jest.fn(async () => tenant);
    const byId = jest.fn(async () => tenant);
    expect(await resolveTenantCredential("ff_live", { byToken, byId })).toEqual({ tenant, via: "ingest" });
    expect(byToken).toHaveBeenCalledWith("ff_live");
    expect(await resolveTenantCredential(mintDashboardSession(TID), { byToken, byId })).toEqual({ tenant, via: "session" });
    expect(byId).toHaveBeenCalledWith(TID);
  });

  it("a disabled or unknown tenant, or a bad credential, resolves to null", async () => {
    const none = jest.fn(async () => null);
    expect(await resolveTenantCredential(mintDashboardSession(TID), { byId: none })).toBeNull();
    expect(await resolveTenantCredential("ff_x", { byToken: none })).toBeNull();
    expect(await resolveTenantCredential("", { byToken: none, byId: none })).toBeNull();
    expect(await resolveTenantCredential(mintConfirmToken(TID, "qa@thewolfpack.agency"), { byId: jest.fn(async () => tenant) })).toBeNull();
  });

  it("never throws", async () => {
    expect(await resolveTenantCredential("ff_x", { byToken: async () => { throw new Error("db"); } })).toBeNull();
  });
});
