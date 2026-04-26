/**
 * Locks in the universal grants every team-role MUST carry. The
 * automations dashboard is the most recent addition: it's read-only,
 * appears in the global nav, and the prod E2E health monitor calls
 * `/api/automations` with whatever role the SMOKE_TEST user has —
 * a missing grant on any role manifests as a 401 + a flaky CI gate.
 */

import {
  capabilitiesForRole,
  roleCapabilityTable,
  type TeamRole,
} from "@/lib/auth/role-capabilities";

const ALL_ROLES: TeamRole[] = ["ceo", "cto", "dev", "sales", "ops", "hr", "designer"];

describe("role-capabilities — universal read-only grants", () => {
  test("every team role carries automations.view (the dashboard is in the global nav)", () => {
    for (const role of ALL_ROLES) {
      const caps = capabilitiesForRole(role);
      expect(caps.has("automations.view")).toBe(true);
    }
  });

  test("dashboard.view is granted to every role (global nav surface)", () => {
    for (const role of ALL_ROLES) {
      expect(capabilitiesForRole(role).has("dashboard.view")).toBe(true);
    }
  });

  test("roleCapabilityTable() returns a row for every TeamRole", () => {
    const table = roleCapabilityTable();
    for (const role of ALL_ROLES) {
      expect(table[role]).toBeDefined();
      expect(table[role].size).toBeGreaterThan(0);
    }
  });

  test("CTO inherits all caps", () => {
    const cto = capabilitiesForRole("cto");
    // CTO is the superset role — must include the most-restricted
    // surfaces (finance, deploys) so the team's owner never gets
    // surprised by a 403 on their own platform.
    expect(cto.has("finance.reports.view")).toBe(true);
    expect(cto.has("automations.view")).toBe(true);
  });
});
