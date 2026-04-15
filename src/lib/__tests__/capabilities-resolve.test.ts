/**
 * Unit tests for the capability resolver: role defaults, grants, revokes,
 * expiration, and normalization.
 */

import {
  CAPABILITIES,
  isCapability,
  allCapabilities,
  type Capability,
} from "../auth/capabilities";
import {
  capabilitiesForRole,
  isTeamRole,
  roleCapabilityTable,
} from "../auth/role-capabilities";
import {
  resolveCapabilities,
  traceCapabilities,
  normalizeOverrides,
  emptyOverrides,
  applyGrant,
  applyRevoke,
} from "../auth/capability-overrides";

describe("capability registry", () => {
  it("isCapability narrows correctly", () => {
    expect(isCapability("docs.view")).toBe(true);
    expect(isCapability("fake.cap")).toBe(false);
    expect(isCapability(null)).toBe(false);
    expect(isCapability(42)).toBe(false);
  });

  it("allCapabilities returns a stable-sorted list of every key", () => {
    const all = allCapabilities();
    const sorted = [...all].sort();
    expect(all).toEqual(sorted);
    expect(new Set(all)).toEqual(new Set(Object.keys(CAPABILITIES)));
  });

  it("every capability has a non-empty human description", () => {
    for (const [k, v] of Object.entries(CAPABILITIES)) {
      expect(typeof v).toBe("string");
      expect(v.length).toBeGreaterThan(0);
      expect(k).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
    }
  });
});

describe("role → default capabilities", () => {
  it("isTeamRole recognizes all defined roles", () => {
    for (const r of ["cto", "ceo", "hr", "sales", "ops", "dev", "designer"]) {
      expect(isTeamRole(r)).toBe(true);
    }
    expect(isTeamRole("admin")).toBe(false);
    expect(isTeamRole(null)).toBe(false);
  });

  it("cto gets every capability", () => {
    const caps = capabilitiesForRole("cto");
    for (const c of Object.keys(CAPABILITIES) as Capability[]) {
      expect(caps.has(c)).toBe(true);
    }
  });

  it("ceo gets admin+finance but NOT sites.deploy", () => {
    const caps = capabilitiesForRole("ceo");
    expect(caps.has("admin.roles.assign")).toBe(true);
    expect(caps.has("finance.reports.view")).toBe(true);
    expect(caps.has("finance.connect")).toBe(true);
    expect(caps.has("sites.deploy")).toBe(false);
  });

  it("hr has payroll + employees; dev does not", () => {
    const hr = capabilitiesForRole("hr");
    const dev = capabilitiesForRole("dev");
    expect(hr.has("hr.payroll.process")).toBe(true);
    expect(hr.has("hr.employees.edit")).toBe(true);
    expect(dev.has("hr.payroll.view")).toBe(false);
    expect(dev.has("hr.employees.view")).toBe(false);
  });

  it("non-privileged roles have no finance access by default", () => {
    for (const r of ["hr", "sales", "ops", "dev", "designer"]) {
      const caps = capabilitiesForRole(r);
      expect(caps.has("finance.reports.view")).toBe(false);
      expect(caps.has("finance.connect")).toBe(false);
    }
  });

  it("unknown role → empty set", () => {
    expect(capabilitiesForRole("nobody").size).toBe(0);
    expect(capabilitiesForRole("").size).toBe(0);
  });

  it("roleCapabilityTable returns an immutable-ish snapshot per role", () => {
    const table = roleCapabilityTable();
    expect(table.cto.size).toBe(Object.keys(CAPABILITIES).length);
    expect(table.sales.has("clients.edit")).toBe(true);
  });
});

describe("resolveCapabilities", () => {
  it("base = role defaults when no overrides", () => {
    const caps = resolveCapabilities("sales", emptyOverrides());
    expect(caps.has("clients.view")).toBe(true);
    expect(caps.has("hr.payroll.view")).toBe(false);
  });

  it("grants extend the base set", () => {
    const caps = resolveCapabilities("sales", {
      grants: ["finance.reports.view"],
      revokes: [],
      expires: {},
    });
    expect(caps.has("finance.reports.view")).toBe(true);
  });

  it("revokes remove from the base set", () => {
    const caps = resolveCapabilities("sales", {
      grants: [],
      revokes: ["clients.edit"],
      expires: {},
    });
    expect(caps.has("clients.view")).toBe(true);
    expect(caps.has("clients.edit")).toBe(false);
  });

  it("revokes also suppress grants (revoke wins)", () => {
    const caps = resolveCapabilities("sales", {
      grants: ["finance.reports.view"],
      revokes: ["finance.reports.view"],
      expires: {},
    });
    expect(caps.has("finance.reports.view")).toBe(false);
  });

  it("expired grants are ignored", () => {
    const past = new Date("2020-01-01T00:00:00Z").toISOString();
    const caps = resolveCapabilities("sales", {
      grants: ["finance.reports.view"],
      revokes: [],
      expires: { "finance.reports.view": past },
    });
    expect(caps.has("finance.reports.view")).toBe(false);
  });

  it("future-expiry grants are honored", () => {
    const future = new Date(Date.now() + 1_000_000).toISOString();
    const caps = resolveCapabilities("sales", {
      grants: ["finance.reports.view"],
      revokes: [],
      expires: { "finance.reports.view": future },
    });
    expect(caps.has("finance.reports.view")).toBe(true);
  });

  it("malformed expiry strings are treated as no-expiry (not expired)", () => {
    const caps = resolveCapabilities("sales", {
      grants: ["finance.reports.view"],
      revokes: [],
      expires: { "finance.reports.view": "not-a-date" as string },
    });
    expect(caps.has("finance.reports.view")).toBe(true);
  });

  it("anonymous / unknown role + any overrides yields only grants", () => {
    const caps = resolveCapabilities("", {
      grants: ["knowledge.search"],
      revokes: [],
      expires: {},
    });
    expect(caps.has("knowledge.search")).toBe(true);
    expect(caps.has("docs.view")).toBe(false);
  });
});

describe("normalizeOverrides", () => {
  it("returns empty shape for garbage input", () => {
    expect(normalizeOverrides(null)).toEqual(emptyOverrides());
    expect(normalizeOverrides(undefined)).toEqual(emptyOverrides());
    expect(normalizeOverrides("nope")).toEqual(emptyOverrides());
    expect(normalizeOverrides(42)).toEqual(emptyOverrides());
  });

  it("strips unknown capabilities from grants/revokes/expires", () => {
    const norm = normalizeOverrides({
      grants: ["docs.view", "not.a.cap"],
      revokes: ["journal.write", 42, "also.fake"],
      expires: { "docs.view": "2099-01-01T00:00:00Z", "bad.cap": "x" },
    });
    expect(norm.grants).toEqual(["docs.view"]);
    expect(norm.revokes).toEqual(["journal.write"]);
    expect(norm.expires).toEqual({ "docs.view": "2099-01-01T00:00:00Z" });
  });
});

describe("applyGrant / applyRevoke", () => {
  it("applyGrant is idempotent and sets expiry when provided", () => {
    const a = applyGrant(emptyOverrides(), "docs.view", "2099-01-01T00:00:00Z");
    const b = applyGrant(a, "docs.view", "2099-01-01T00:00:00Z");
    expect(a).toEqual(b);
    expect(a.grants).toEqual(["docs.view"]);
    expect(a.expires["docs.view"]).toBe("2099-01-01T00:00:00Z");
  });

  it("applyGrant removes a prior revoke for the same cap", () => {
    const revoked = applyRevoke(emptyOverrides(), "docs.view");
    expect(revoked.revokes).toEqual(["docs.view"]);
    const granted = applyGrant(revoked, "docs.view");
    expect(granted.revokes).toEqual([]);
    expect(granted.grants).toEqual(["docs.view"]);
  });

  it("applyRevoke removes grant + expiry for the same cap", () => {
    const granted = applyGrant(emptyOverrides(), "docs.view", "2099-01-01T00:00:00Z");
    const revoked = applyRevoke(granted, "docs.view");
    expect(revoked.grants).toEqual([]);
    expect(revoked.revokes).toEqual(["docs.view"]);
    expect(revoked.expires["docs.view"]).toBeUndefined();
  });
});

describe("traceCapabilities", () => {
  it("marks role caps and grants correctly", () => {
    const trace = traceCapabilities("sales", {
      grants: ["finance.reports.view"],
      revokes: ["clients.edit"],
      expires: {},
    });
    const byCap = Object.fromEntries(trace.map((t) => [t.capability, t.source]));
    expect(byCap["clients.view"]).toBe("role");
    expect(byCap["clients.edit"]).toBe("revoked");
    expect(byCap["finance.reports.view"]).toBe("grant");
  });

  it("marks expired grants as expired-grant", () => {
    const past = new Date("2020-01-01T00:00:00Z").toISOString();
    const trace = traceCapabilities("sales", {
      grants: ["finance.reports.view"],
      revokes: [],
      expires: { "finance.reports.view": past },
    });
    const entry = trace.find((t) => t.capability === "finance.reports.view");
    expect(entry?.source).toBe("expired-grant");
    expect(entry?.expiresAt).toBe(past);
  });
});
