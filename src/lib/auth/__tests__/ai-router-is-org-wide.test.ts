/**
 * Every seat can read the model router. No seat gains the probe by accident.
 *
 * Asked for on 2026-08-24: the router page should be visible to everyone, so
 * the team can see how it works. It was leadership only (ceo, cto, evp, vp,
 * cco), which left the engine that decides every AI call unchecked by the five
 * roles that use the assistant all day.
 *
 * The split is deliberate and this file is what holds it:
 *   READING   is org-wide, like the changelog and the engineering wiki.
 *   THE PROBE sends a real inference call to every configured provider, costs
 *             money on click, and stays with the roles that manage the
 *             deployment.
 *
 * Granting router.view to a role is therefore safe; granting
 * settings.manage_team is not, and the second assertion here is what stops
 * somebody widening the first and taking the second along with it.
 */
import { capabilitiesForRole, type TeamRole } from "../role-capabilities";

const ROLES: TeamRole[] = ["ceo", "cto", "evp", "vp", "cco", "dev", "sales", "ops", "hr", "designer"];
const PRIVILEGED: TeamRole[] = ["ceo", "cto", "evp", "vp", "cco"];

describe("reading the model router", () => {
  it.each(ROLES)("%s can read it", (role) => {
    expect([...capabilitiesForRole(role)]).toContain("router.view");
  });
});

describe("running the probe", () => {
  it.each(ROLES.filter((r) => !PRIVILEGED.includes(r)))(
    "%s cannot run the probe just because it can read the page",
    (role) => {
      expect([...capabilitiesForRole(role)]).not.toContain("settings.manage_team");
    },
  );

  it("the roles that manage the deployment still can", () => {
    for (const role of PRIVILEGED) {
      expect([...capabilitiesForRole(role)]).toContain("settings.manage_team");
    }
  });
});
