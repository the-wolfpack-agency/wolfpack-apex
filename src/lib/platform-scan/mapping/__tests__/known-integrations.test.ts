/**
 * What this workspace runs, offered to the scanner as an explanation.
 */
const mockSafe = jest.fn();
jest.mock("@/lib/db", () => ({ safeQuery: (...a: unknown[]) => mockSafe(...a) }));

import { hostsForVendors, healthyVendorsFor, INTEGRATION_HOSTS } from "../known-integrations";

beforeEach(() => mockSafe.mockReset().mockResolvedValue({ rows: [] }));

describe("mapping integrations to hosts", () => {
  it("names the integration a host belongs to, in words a reader uses", () => {
    const hosts = hostsForVendors(["salesforce"]);
    expect(hosts.map((h) => h.host)).toContain("salesforce.com");
    expect(hosts[0].name).toMatch(/Salesforce integration/);
  });

  it("says nothing about a vendor it has no signatures for", () => {
    expect(hostsForVendors(["some-vendor-we-never-added"])).toEqual([]);
  });

  it("does not repeat a host claimed by two integrations", () => {
    const hosts = hostsForVendors(["microsoft", "microsoft"]);
    expect(new Set(hosts.map((h) => h.host)).size).toBe(hosts.length);
  });

  it("finds nothing for a workspace running nothing", () => {
    expect(hostsForVendors([])).toEqual([]);
  });
});

describe("which integrations count as an explanation", () => {
  /* A vendor whose credentials stopped working does not account for live
     traffic to it. If something is still contacting it, that is the finding
     rather than the excuse. */
  it("ignores an integration whose latest probe failed", async () => {
    mockSafe.mockResolvedValue({
      rows: [
        { vendor: "salesforce", ok: true },
        { vendor: "hubspot", ok: false },
      ],
    });
    expect(await healthyVendorsFor("ws-1")).toEqual(["salesforce"]);
  });

  it("scopes to the workspace", async () => {
    await healthyVendorsFor("ws-1");
    expect(mockSafe.mock.calls[0][1]).toEqual(["ws-1"]);
    expect(mockSafe.mock.calls[0][0]).toMatch(/workspace_id = \$1/);
  });

  /* An unavailable health table must not stop a scan. Explaining nothing is
     the same answer this had before anything explained anything. */
  it("explains nothing rather than failing when the table is unavailable", async () => {
    mockSafe.mockResolvedValue({ rows: [] });
    expect(await healthyVendorsFor("ws-1")).toEqual([]);
  });
});

describe("the host table itself", () => {
  /* Precision-first: a host missing from here is reported as unexplained,
     which is the safe direction to be wrong in. A wildcard would explain away
     traffic nobody checked. */
  it("contains no wildcards", () => {
    for (const hosts of Object.values(INTEGRATION_HOSTS)) {
      for (const h of hosts) expect(h).not.toMatch(/[*?]/);
    }
  });

  it("covers the integrations this product actually probes", () => {
    for (const v of ["microsoft", "salesforce", "hubspot", "quickbooks"]) {
      expect(Object.keys(INTEGRATION_HOSTS)).toContain(v);
    }
  });
});
