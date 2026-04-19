/**
 * site-domains.ts — orchestration layer tests.
 *
 * Mocks:
 *   - @/lib/db (safeQuery) — so we can assert SQL parameter flow.
 *   - @/lib/analytics (trackEvent) — so we can assert learning-loop signal.
 *   - @/lib/sites-domain (addDomainToProject / getDomainStatus /
 *     removeDomainFromProject) — so NO real Vercel calls ever fire.
 *
 * Covers: register fires analytics + inserts, register persists failures,
 * register surfaces Vercel errors, refresh updates, refresh detects
 * verified transition, unregister removes Vercel AND updates DB,
 * unregister is idempotent.
 */

const safeQueryMock = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...args: unknown[]) => safeQueryMock(...args),
}));

const trackMock = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => trackMock(...args),
}));

const addMock = jest.fn();
const statusMock = jest.fn();
const removeMock = jest.fn();
// We import the real sites-domain symbols (isValidDomain,
// VercelDomainError) so error classification is exercised end-to-end,
// and override the three network-bound functions.
jest.mock("@/lib/sites-domain", () => {
  const actual = jest.requireActual("@/lib/sites-domain");
  return {
    ...actual,
    addDomainToProject: (...args: unknown[]) => addMock(...args),
    getDomainStatus: (...args: unknown[]) => statusMock(...args),
    removeDomainFromProject: (...args: unknown[]) => removeMock(...args),
  };
});

import {
  registerDomain,
  refreshDomainStatus,
  unregisterDomain,
  listDomainsForSite,
} from "@/lib/site-domains";
import { VercelDomainError } from "@/lib/sites-domain";

const FAKE_RESOLVER = jest
  .fn()
  .mockResolvedValue({ projectId: "prj_123", clientSlug: "acme" });

beforeEach(() => {
  jest.clearAllMocks();
  process.env.VERCEL_TOKEN_WOLFPACK_AGENCY = "tok_xyz";
  process.env.VERCEL_ORG_ID = "team_abc";
  FAKE_RESOLVER.mockResolvedValue({ projectId: "prj_123", clientSlug: "acme" });
});

afterEach(() => {
  delete process.env.VERCEL_TOKEN_WOLFPACK_AGENCY;
  delete process.env.VERCEL_ORG_ID;
});

describe("registerDomain", () => {
  it("inserts a row, tracks site.domain_added, returns the record", async () => {
    addMock.mockResolvedValueOnce({
      domain: "acme.com",
      verified: false,
      verification: [{ type: "TXT", domain: "_vercel.acme.com", value: "vc-1" }],
      createdAt: 1700000000000,
    });
    safeQueryMock.mockResolvedValueOnce({
      rows: [
        {
          id: "domain_1",
          site_id: "site_1",
          domain: "acme.com",
          status: "pending",
          verification_records: [{ type: "TXT", domain: "_vercel.acme.com", value: "vc-1" }],
          added_by: "u_1",
          added_at: "2026-04-19T00:00:00Z",
          verified_at: null,
          removed_at: null,
          last_error: null,
        },
      ],
      fromCache: false,
    });

    const rec = await registerDomain({
      siteId: "site_1",
      domain: "acme.com",
      userId: "u_1",
      userRole: "sales",
      resolveProjectId: FAKE_RESOLVER,
    });
    expect(rec.status).toBe("pending");
    expect(rec.verification_records).toHaveLength(1);
    expect(addMock).toHaveBeenCalledWith({
      projectId: "prj_123",
      domain: "acme.com",
      teamId: "team_abc",
      token: "tok_xyz",
    });
    const sql = safeQueryMock.mock.calls[0][0] as string;
    expect(sql).toContain("INSERT INTO apex_site_domains");
    expect(trackMock).toHaveBeenCalledWith(
      "site.domain_added",
      "u_1",
      "sales",
      expect.objectContaining({ site_id: "site_1", domain: "acme.com", pending: true }),
    );
  });

  it("fires site.domain_verified immediately when Vercel reports verified:true", async () => {
    addMock.mockResolvedValueOnce({
      domain: "acme.com",
      verified: true,
      verification: [],
      createdAt: 1700000000000,
    });
    safeQueryMock.mockResolvedValueOnce({ rows: [{ id: "d", site_id: "site_1", domain: "acme.com", status: "verified", verification_records: [], added_by: "u_1", added_at: "t", verified_at: "t", removed_at: null, last_error: null }], fromCache: false });

    await registerDomain({
      siteId: "site_1",
      domain: "acme.com",
      userId: "u_1",
      userRole: "sales",
      resolveProjectId: FAKE_RESOLVER,
    });
    const events = trackMock.mock.calls.map((c) => c[0]);
    expect(events).toContain("site.domain_added");
    expect(events).toContain("site.domain_verified");
  });

  it("rejects invalid-shape domain, fires site.domain_add_failed? no — validation is hard fail BEFORE analytics", async () => {
    // The spec keeps invalid-domain as a pure client error — no Vercel
    // call happens AND no persisted failure row (we'd get the same 400
    // every time; nothing to learn).
    await expect(
      registerDomain({
        siteId: "site_1",
        domain: "not a domain",
        userId: "u_1",
        userRole: "sales",
        resolveProjectId: FAKE_RESOLVER,
      }),
    ).rejects.toMatchObject({ code: "domain_invalid" });
    expect(addMock).not.toHaveBeenCalled();
    expect(safeQueryMock).not.toHaveBeenCalled();
  });

  it("surfaces Vercel domain_in_use errors without inserting a row", async () => {
    addMock.mockRejectedValueOnce(
      new VercelDomainError("domain_in_use", 409, "already attached"),
    );
    await expect(
      registerDomain({
        siteId: "site_1",
        domain: "acme.com",
        userId: "u_1",
        userRole: "sales",
        resolveProjectId: FAKE_RESOLVER,
      }),
    ).rejects.toMatchObject({ code: "domain_in_use" });
    // We should NOT insert a 'failed' row on 409 — the unique
    // constraint would just re-throw on retry.
    const insertCalls = safeQueryMock.mock.calls.filter((c) =>
      String(c[0]).includes("INSERT"),
    );
    expect(insertCalls).toHaveLength(0);
    expect(trackMock).toHaveBeenCalledWith(
      "site.domain_add_failed",
      "u_1",
      "sales",
      expect.objectContaining({ reason: "domain_in_use" }),
    );
  });

  it("persists a status=failed row on non-409 Vercel errors", async () => {
    addMock.mockRejectedValueOnce(
      new VercelDomainError("network", 0, "ECONNRESET"),
    );
    safeQueryMock.mockResolvedValueOnce({ rows: [], fromCache: false });
    await expect(
      registerDomain({
        siteId: "site_1",
        domain: "acme.com",
        userId: "u_1",
        userRole: "sales",
        resolveProjectId: FAKE_RESOLVER,
      }),
    ).rejects.toMatchObject({ code: "network" });
    const inserts = safeQueryMock.mock.calls.filter((c) =>
      String(c[0]).includes("INSERT"),
    );
    expect(inserts).toHaveLength(1);
    expect(String(inserts[0][0])).toContain("'failed'");
  });

  it("503 + site.domain_add_failed when Vercel project lookup returns null", async () => {
    const resolver = jest
      .fn()
      .mockResolvedValue({ projectId: null, clientSlug: "acme" });
    await expect(
      registerDomain({
        siteId: "site_1",
        domain: "acme.com",
        userId: "u_1",
        userRole: "sales",
        resolveProjectId: resolver,
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(trackMock).toHaveBeenCalledWith(
      "site.domain_add_failed",
      "u_1",
      "sales",
      expect.objectContaining({ reason: "vercel_project_not_found" }),
    );
    expect(addMock).not.toHaveBeenCalled();
  });

  it("503 + site.domain_add_failed when env creds are missing", async () => {
    delete process.env.VERCEL_TOKEN_WOLFPACK_AGENCY;
    await expect(
      registerDomain({
        siteId: "site_1",
        domain: "acme.com",
        userId: "u_1",
        userRole: "sales",
        resolveProjectId: FAKE_RESOLVER,
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(trackMock).toHaveBeenCalledWith(
      "site.domain_add_failed",
      "u_1",
      "sales",
      expect.objectContaining({ reason: "env_not_configured" }),
    );
  });
});

describe("refreshDomainStatus", () => {
  it("updates row with new verification state", async () => {
    // Prior row lookup
    safeQueryMock.mockResolvedValueOnce({
      rows: [{ status: "pending", added_at: "2026-04-19T00:00:00Z" }],
      fromCache: false,
    });
    // Vercel status: still pending
    statusMock.mockResolvedValueOnce({
      domain: "acme.com",
      verified: false,
      verification: [{ type: "TXT", domain: "_vercel.acme.com", value: "vc-1" }],
      createdAt: 1700000000000,
    });
    // UPDATE result
    safeQueryMock.mockResolvedValueOnce({
      rows: [
        {
          id: "d",
          site_id: "site_1",
          domain: "acme.com",
          status: "pending",
          verification_records: [{ type: "TXT", domain: "_vercel.acme.com", value: "vc-1" }],
          added_by: "u_1",
          added_at: "2026-04-19T00:00:00Z",
          verified_at: null,
          removed_at: null,
          last_error: null,
        },
      ],
      fromCache: false,
    });
    const rec = await refreshDomainStatus({
      siteId: "site_1",
      domain: "acme.com",
      userId: "u_1",
      userRole: "sales",
      resolveProjectId: FAKE_RESOLVER,
    });
    expect(rec.status).toBe("pending");
    // site.domain_verified should NOT fire — still pending.
    expect(trackMock).not.toHaveBeenCalledWith(
      "site.domain_verified",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("fires site.domain_verified when status flips pending → verified", async () => {
    safeQueryMock.mockResolvedValueOnce({
      rows: [{ status: "pending", added_at: new Date(Date.now() - 90_000).toISOString() }],
      fromCache: false,
    });
    statusMock.mockResolvedValueOnce({
      domain: "acme.com",
      verified: true,
      verification: [],
      createdAt: 1700000000000,
    });
    safeQueryMock.mockResolvedValueOnce({
      rows: [
        {
          id: "d",
          site_id: "site_1",
          domain: "acme.com",
          status: "verified",
          verification_records: [],
          added_by: "u_1",
          added_at: new Date(Date.now() - 90_000).toISOString(),
          verified_at: new Date().toISOString(),
          removed_at: null,
          last_error: null,
        },
      ],
      fromCache: false,
    });

    await refreshDomainStatus({
      siteId: "site_1",
      domain: "acme.com",
      userId: "u_1",
      userRole: "sales",
      resolveProjectId: FAKE_RESOLVER,
    });
    expect(trackMock).toHaveBeenCalledWith(
      "site.domain_verified",
      "u_1",
      "sales",
      expect.objectContaining({
        site_id: "site_1",
        domain: "acme.com",
      }),
    );
  });

  it("marks removed when Vercel returns null", async () => {
    safeQueryMock.mockResolvedValueOnce({
      rows: [{ status: "pending", added_at: "2026-04-19T00:00:00Z" }],
      fromCache: false,
    });
    statusMock.mockResolvedValueOnce(null);
    safeQueryMock.mockResolvedValueOnce({
      rows: [
        {
          id: "d",
          site_id: "site_1",
          domain: "acme.com",
          status: "removed",
          verification_records: [],
          added_by: "u_1",
          added_at: "t",
          verified_at: null,
          removed_at: "t",
          last_error: null,
        },
      ],
      fromCache: false,
    });
    const rec = await refreshDomainStatus({
      siteId: "site_1",
      domain: "acme.com",
      userId: "u_1",
      userRole: "sales",
      resolveProjectId: FAKE_RESOLVER,
    });
    expect(rec.status).toBe("removed");
  });
});

describe("unregisterDomain", () => {
  it("calls Vercel remove AND updates DB to status=removed", async () => {
    removeMock.mockResolvedValueOnce({ success: true });
    safeQueryMock.mockResolvedValueOnce({ rows: [], fromCache: false });
    await unregisterDomain({
      siteId: "site_1",
      domain: "acme.com",
      userId: "u_1",
      userRole: "sales",
      resolveProjectId: FAKE_RESOLVER,
    });
    expect(removeMock).toHaveBeenCalledWith({
      projectId: "prj_123",
      domain: "acme.com",
      teamId: "team_abc",
      token: "tok_xyz",
    });
    const sql = safeQueryMock.mock.calls[0][0] as string;
    expect(sql).toContain("status = 'removed'");
    expect(trackMock).toHaveBeenCalledWith(
      "site.domain_removed",
      "u_1",
      "sales",
      expect.objectContaining({ site_id: "site_1", domain: "acme.com" }),
    );
  });

  it("is idempotent — Vercel throw still flips DB + tracks failure reason", async () => {
    removeMock.mockRejectedValueOnce(
      new VercelDomainError("network", 0, "ECONNRESET"),
    );
    safeQueryMock.mockResolvedValueOnce({ rows: [], fromCache: false });
    await unregisterDomain({
      siteId: "site_1",
      domain: "acme.com",
      userId: "u_1",
      userRole: "sales",
      resolveProjectId: FAKE_RESOLVER,
    });
    const sql = safeQueryMock.mock.calls[0][0] as string;
    expect(sql).toContain("status = 'removed'");
    const reasons = trackMock.mock.calls.map((c) => c[0]);
    expect(reasons).toContain("site.domain_removed");
    expect(reasons).toContain("site.domain_add_failed");
  });

  it("rejects invalid domain shape before touching Vercel or DB", async () => {
    await expect(
      unregisterDomain({
        siteId: "site_1",
        domain: "not a domain",
        userId: "u_1",
        userRole: "sales",
        resolveProjectId: FAKE_RESOLVER,
      }),
    ).rejects.toMatchObject({ code: "domain_invalid" });
    expect(removeMock).not.toHaveBeenCalled();
    expect(safeQueryMock).not.toHaveBeenCalled();
  });
});

describe("listDomainsForSite", () => {
  it("returns rows mapped through rowToRecord", async () => {
    safeQueryMock.mockResolvedValueOnce({
      rows: [
        {
          id: "d1",
          site_id: "site_1",
          domain: "acme.com",
          status: "verified",
          verification_records: [],
          added_by: "u_1",
          added_at: "t",
          verified_at: "t",
          removed_at: null,
          last_error: null,
        },
      ],
      fromCache: false,
    });
    const rows = await listDomainsForSite("site_1");
    expect(rows).toHaveLength(1);
    expect(rows[0].domain).toBe("acme.com");
    const sql = safeQueryMock.mock.calls[0][0] as string;
    expect(sql).toContain("FROM apex_site_domains");
    expect(sql).toContain("ORDER BY added_at DESC");
  });

  it("handles verification_records stored as JSON string", async () => {
    safeQueryMock.mockResolvedValueOnce({
      rows: [
        {
          id: "d1",
          site_id: "site_1",
          domain: "acme.com",
          status: "pending",
          verification_records: '[{"type":"TXT","domain":"_vercel.acme.com","value":"vc-1"}]',
          added_by: "u_1",
          added_at: "t",
          verified_at: null,
          removed_at: null,
          last_error: null,
        },
      ],
      fromCache: false,
    });
    const rows = await listDomainsForSite("site_1");
    expect(rows[0].verification_records).toHaveLength(1);
    expect(rows[0].verification_records[0].type).toBe("TXT");
  });
});
