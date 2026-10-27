/** @jest-environment node */
/**
 * Forcefield Edge tenant records, with an injected query fn (no DB). The origin
 * secret is sealed at rest (never written in the clear), issued once, and opened
 * only when resolving a hostname for the Edge app. A hostname belongs to one
 * tenant. `enforce` is the console toggle AND the license.
 */
import {
  generateEdgeSecret,
  validateEdgeOrigin,
  normalizeEdgeHostname,
  setEdgeOrigin,
  rotateEdgeSecret,
  addEdgeHostname,
  resolveEdgeSiteByHost,
  resolveActiveTenantById,
  getEdgeTenantState,
  listEdgeHostnames,
} from "../edge-sites";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secret-storage";

type Call = { sql: string; params: unknown[] };
function fakeQ(handler: (sql: string, params: unknown[]) => unknown[]) {
  const calls: Call[] = [];
  const q = (async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params: params ?? [] });
    return handler(sql, params ?? []);
  }) as never;
  return { q, calls };
}

const TID = "6f1c2a1e-3b7d-4c55-9a10-2b3c4d5e6f70";

describe("secrets + validation", () => {
  it("generates a prefixed, high-entropy, unique secret", () => {
    const a = generateEdgeSecret();
    expect(a).toMatch(/^ffe_[A-Za-z0-9_-]{43}$/);
    expect(generateEdgeSecret()).not.toBe(a);
  });

  it("validateEdgeOrigin: https scheme + host only, and the host must be public", async () => {
    const pass = jest.fn(async () => {});
    expect(await validateEdgeOrigin("https://origin.client.example/", pass)).toEqual({ ok: true, origin: "https://origin.client.example" });
    expect(await validateEdgeOrigin("https://origin.client.example:8443", pass)).toEqual({ ok: true, origin: "https://origin.client.example:8443" });
    for (const bad of ["http://origin.client.example", "https://origin.client.example/wp", "https://u:p@origin.client.example", "ftp://x.example", "", 42]) {
      expect(await validateEdgeOrigin(bad, pass)).toEqual({ ok: false, reason: "invalid_origin" });
    }
    const ssrf = jest.fn(async () => {
      throw new Error("private");
    });
    expect(await validateEdgeOrigin("https://internal.example", ssrf)).toEqual({ ok: false, reason: "origin_not_public" });
  });

  it("validateEdgeOrigin uses the real SSRF guard by default (loopback / metadata refused)", async () => {
    expect(await validateEdgeOrigin("https://127.0.0.1")).toEqual({ ok: false, reason: "origin_not_public" });
    expect(await validateEdgeOrigin("https://169.254.169.254")).toEqual({ ok: false, reason: "origin_not_public" });
    expect(await validateEdgeOrigin("https://localhost")).toEqual({ ok: false, reason: "origin_not_public" });
  });

  it("normalizeEdgeHostname: lowercase, no port / trailing dot; IPs and junk refused", () => {
    expect(normalizeEdgeHostname("Edge-Test.OGIAM.com.")).toBe("edge-test.ogiam.com");
    expect(normalizeEdgeHostname("a.example.com:443")).toBe("a.example.com");
    for (const bad of ["10.0.0.1", "localhost", "a b.com", "", "[::1]", "x", 7]) expect(normalizeEdgeHostname(bad)).toBeNull();
  });
});

describe("setEdgeOrigin / rotateEdgeSecret", () => {
  it("first set issues a secret, stores it SEALED, returns the clear value once", async () => {
    const { q, calls } = fakeQ((sql) => (sql.startsWith("SELECT") ? [{ edge_origin_secret_sealed: null }] : [{ id: TID }]));
    const r = await setEdgeOrigin(TID, "https://origin.client.example", {}, q);
    expect(r?.secret).toMatch(/^ffe_/);
    const update = calls[1];
    expect(update.sql).toContain("edge_origin_secret_sealed = $3");
    const stored = update.params[2] as string;
    expect(stored).not.toContain(r!.secret!); // never in the clear
    expect(decryptSecret(stored)).toBe(r!.secret);
  });

  it("a later set keeps the secret and returns none", async () => {
    const { q, calls } = fakeQ((sql) => (sql.startsWith("SELECT") ? [{ edge_origin_secret_sealed: encryptSecret("ffe_existing") }] : [{ id: TID }]));
    const r = await setEdgeOrigin(TID, "https://origin2.client.example", {}, q);
    expect(r).toEqual({ origin: "https://origin2.client.example", secret: null });
    expect(calls[1].sql).not.toContain("edge_origin_secret_sealed");
  });

  it("unknown / disabled tenant -> null; a DB error -> null, never a throw", async () => {
    expect(await setEdgeOrigin(TID, "https://o.example", {}, fakeQ(() => []).q)).toBeNull();
    const boom = (async () => {
      throw new Error("db down");
    }) as never;
    expect(await setEdgeOrigin(TID, "https://o.example", {}, boom)).toBeNull();
    expect(await rotateEdgeSecret(TID, boom)).toBeNull();
  });

  it("rotate issues a new sealed secret only for an active tenant with an origin", async () => {
    const { q, calls } = fakeQ(() => [{ id: TID }]);
    const r = await rotateEdgeSecret(TID, q);
    expect(r?.secret).toMatch(/^ffe_/);
    expect(calls[0].sql).toContain("edge_origin_url IS NOT NULL");
    expect(decryptSecret(calls[0].params[1] as string)).toBe(r!.secret);
    expect(await rotateEdgeSecret(TID, fakeQ(() => []).q)).toBeNull();
  });
});

describe("addEdgeHostname", () => {
  const tenantRow = [{ edge_origin_url: "https://origin.client.example" }];

  it("claims a free hostname", async () => {
    const { q } = fakeQ((sql) => (sql.includes("FROM forcefield_tenants") ? tenantRow : sql.startsWith("SELECT") ? [] : [{ hostname: "a.example.com" }]));
    expect(await addEdgeHostname(TID, "a.example.com", q)).toEqual({ ok: true, hostname: "a.example.com", created: true });
  });

  it("re-adding its own hostname is a no-op success", async () => {
    const { q } = fakeQ((sql) => (sql.includes("FROM forcefield_tenants") ? tenantRow : [{ tenant_id: TID }]));
    expect(await addEdgeHostname(TID, "a.example.com", q)).toEqual({ ok: true, hostname: "a.example.com", created: false });
  });

  it("refuses a hostname another tenant holds (checked, and on an insert race)", async () => {
    const held = fakeQ((sql) => (sql.includes("FROM forcefield_tenants") ? tenantRow : [{ tenant_id: "someone-else" }]));
    expect(await addEdgeHostname(TID, "a.example.com", held.q)).toEqual({ ok: false, error: "hostname_in_use" });
    const race = fakeQ((sql) => (sql.includes("FROM forcefield_tenants") ? tenantRow : []));
    expect(await addEdgeHostname(TID, "a.example.com", race.q)).toEqual({ ok: false, error: "hostname_in_use" });
  });

  it("requires an origin first, and an active tenant", async () => {
    expect(await addEdgeHostname(TID, "a.example.com", fakeQ(() => [{ edge_origin_url: null }]).q)).toEqual({ ok: false, error: "no_origin" });
    expect(await addEdgeHostname(TID, "a.example.com", fakeQ(() => []).q)).toEqual({ ok: false, error: "not_found" });
  });
});

describe("resolveEdgeSiteByHost", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    tenant_id: TID,
    site_label: "client.example",
    platform: "wordpress",
    edge_origin_url: "https://origin.client.example",
    edge_origin_secret_sealed: encryptSecret("ffe_" + "k".repeat(43)),
    enforce_enabled: true,
    subscription_status: "active",
    current_period_end: null,
    ...over,
  });

  it("returns the record with the opened secret; enforce = console toggle AND license", async () => {
    const { q, calls } = fakeQ(() => [row()]);
    const s = await resolveEdgeSiteByHost("WWW.client.example", q);
    expect(s).toEqual({
      tenantId: TID,
      siteLabel: "client.example",
      originUrl: "https://origin.client.example",
      originSecret: "ffe_" + "k".repeat(43),
      enforce: true,
      platform: "wordpress",
    });
    expect(calls[0].params).toEqual(["www.client.example"]);
    expect(calls[0].sql).toContain("t.status = 'active'");
  });

  it("enforce is false when the toggle is off OR the license lapsed", async () => {
    expect((await resolveEdgeSiteByHost("a.example.com", fakeQ(() => [row({ enforce_enabled: false })]).q))?.enforce).toBe(false);
    expect((await resolveEdgeSiteByHost("a.example.com", fakeQ(() => [row({ subscription_status: "canceled" })]).q))?.enforce).toBe(false);
    expect((await resolveEdgeSiteByHost("a.example.com", fakeQ(() => [row({ current_period_end: "2020-01-01" })]).q))?.enforce).toBe(false);
  });

  it("null when unknown, no origin, no secret, an unopenable secret, an invalid host, or a DB error", async () => {
    expect(await resolveEdgeSiteByHost("a.example.com", fakeQ(() => []).q)).toBeNull();
    expect(await resolveEdgeSiteByHost("a.example.com", fakeQ(() => [row({ edge_origin_url: null })]).q)).toBeNull();
    expect(await resolveEdgeSiteByHost("a.example.com", fakeQ(() => [row({ edge_origin_secret_sealed: null })]).q)).toBeNull();
    expect(await resolveEdgeSiteByHost("a.example.com", fakeQ(() => [row({ edge_origin_secret_sealed: "v1.garbage" })]).q)).toBeNull();
    const never = fakeQ(() => [row()]);
    expect(await resolveEdgeSiteByHost("127.0.0.1", never.q)).toBeNull();
    expect(never.calls).toHaveLength(0);
    expect(await resolveEdgeSiteByHost("a.example.com", (async () => { throw new Error("x"); }) as never)).toBeNull();
  });
});

describe("admin read helpers + ingest tenant lookup", () => {
  it("getEdgeTenantState never selects the secret itself", async () => {
    const { q, calls } = fakeQ(() => [{ edge_origin_url: "https://o.example", has_secret: true, edge_secret_rotated_at: "2026-10-26" }]);
    expect(await getEdgeTenantState(TID, q)).toEqual({ originUrl: "https://o.example", hasSecret: true, secretRotatedAt: "2026-10-26" });
    expect(calls[0].sql).toContain("(edge_origin_secret_sealed IS NOT NULL) AS has_secret");
  });

  it("listEdgeHostnames maps rows", async () => {
    const { q } = fakeQ(() => [{ hostname: "a.example.com", verified: true, dns_records: [{ type: "CNAME", name: "a", value: "x", purpose: "route" }], last_checked_at: null }]);
    expect(await listEdgeHostnames(TID, q)).toEqual([{ hostname: "a.example.com", verified: true, dnsRecords: [{ type: "CNAME", name: "a", value: "x", purpose: "route" }], lastCheckedAt: null }]);
  });

  it("resolveActiveTenantById validates the id shape before any query", async () => {
    const { q, calls } = fakeQ(() => [{ id: TID, site_label: "client.example" }]);
    expect(await resolveActiveTenantById("not-a-uuid", q)).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await resolveActiveTenantById(TID, q)).toEqual({ id: TID, siteLabel: "client.example" });
    expect(calls[0].sql).toContain("status = 'active'");
  });
});
