import { mergeRoster, summarizeRoster, type EmployeeInput, type MemberInput, type InviteInput } from "../roster";

/**
 * The rules that decide what /hr shows.
 *
 * The bug these exist for: the page listed `apex_employees` only, so somebody
 * who was invited and accepted had access and appeared nowhere. You could not
 * see who could sign in, and there was nothing to remove access from.
 *
 * So the case that matters most below is "an account with no employee record
 * still appears". That is the person the old view hid completely.
 */

const emp = (o: Partial<EmployeeInput> & { id: string }): EmployeeInput => ({
  full_name: "Employee",
  email: null,
  role_title: null,
  department: null,
  status: "active",
  ...o,
});

const member = (o: Partial<MemberInput> & { id: string; email: string }): MemberInput => ({
  name: "Member",
  role: "ops",
  is_active: true,
  last_login: null,
  m365_connected: false,
  ...o,
});

const invite = (o: Partial<InviteInput> & { id: string; email: string }): InviteInput => ({
  role: "ops",
  created_at: "2026-08-01T00:00:00Z",
  ...o,
});

describe("everyone with access appears, employee record or not", () => {
  it("shows an account that has no employee record", () => {
    // The exact regression. Before, this person was invisible on /hr.
    const roster = mergeRoster({
      employees: [],
      members: [member({ id: "m1", email: "new@wolfpack.test", name: "Newcomer" })],
      invites: [],
    });
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({
      name: "Newcomer",
      member_id: "m1",
      employee_id: null,
      access: "active",
    });
  });

  it("shows an employee who has no account, as having none", () => {
    const roster = mergeRoster({
      employees: [emp({ id: "e1", full_name: "Contractor", email: "c@wolfpack.test" })],
      members: [],
      invites: [],
    });
    expect(roster[0]).toMatchObject({ employee_id: "e1", member_id: null, access: "none" });
  });

  it("merges the two into ONE row when the email matches", () => {
    const roster = mergeRoster({
      employees: [emp({ id: "e1", full_name: "Alice Smith", email: "alice@wolfpack.test", role_title: "Eng" })],
      members: [member({ id: "m1", email: "alice@wolfpack.test", name: "alice", role: "dev" })],
      invites: [],
    });
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({
      employee_id: "e1",
      member_id: "m1",
      role_title: "Eng",
      account_role: "dev",
      access: "active",
    });
    // The HR record wins the name: it is what an administrator typed, where the
    // member name may have come from an OAuth profile.
    expect(roster[0].name).toBe("Alice Smith");
  });

  it("matches regardless of case, the way the unique index does", () => {
    const roster = mergeRoster({
      employees: [emp({ id: "e1", full_name: "Pat", email: "Pat@Wolfpack.Test" })],
      members: [member({ id: "m1", email: "pat@wolfpack.test" })],
      invites: [],
    });
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ employee_id: "e1", member_id: "m1" });
  });
});

describe("access state", () => {
  it("reports a deactivated account as removed, not as absent", () => {
    // Filtering these out is what makes somebody vanish, which reads as "never
    // existed" rather than "no longer has access" and leaves nothing to restore.
    const roster = mergeRoster({
      employees: [],
      members: [member({ id: "m1", email: "gone@wolfpack.test", is_active: false })],
      invites: [],
    });
    expect(roster[0].access).toBe("revoked");
    expect(roster[0].member_id).toBe("m1");
  });

  it("reports an unaccepted invite as invited", () => {
    const roster = mergeRoster({
      employees: [],
      members: [],
      invites: [invite({ id: "i1", email: "pending@wolfpack.test", role: "sales" })],
    });
    expect(roster[0]).toMatchObject({ access: "invited", invite_id: "i1", account_role: "sales" });
  });

  it("an account outranks a stale invite for the same address", () => {
    // Somebody can be invited and then sign in through Microsoft OAuth without
    // opening the link, leaving a pending invite that means nothing. Showing
    // them as merely "invited" would be wrong.
    const roster = mergeRoster({
      employees: [],
      members: [member({ id: "m1", email: "both@wolfpack.test" })],
      invites: [invite({ id: "i1", email: "both@wolfpack.test" })],
    });
    expect(roster).toHaveLength(1);
    expect(roster[0].access).toBe("active");
    expect(roster[0].invite_id).toBeNull();
  });

  it("carries last_login and m365 through", () => {
    const roster = mergeRoster({
      employees: [],
      members: [
        member({ id: "m1", email: "a@wolfpack.test", last_login: "2026-08-01T10:00:00Z", m365_connected: true }),
      ],
      invites: [],
    });
    expect(roster[0]).toMatchObject({ last_login: "2026-08-01T10:00:00Z", m365_connected: true });
  });
});

describe("rows that cannot be joined", () => {
  it("keeps employees with no email as separate rows", () => {
    // NULLs are distinct in Postgres too, so several such rows can coexist.
    const roster = mergeRoster({
      employees: [emp({ id: "e1", full_name: "One" }), emp({ id: "e2", full_name: "Two" })],
      members: [],
      invites: [],
    });
    expect(roster).toHaveLength(2);
    expect(new Set(roster.map((r) => r.key))).toEqual(new Set(["e1", "e2"]));
  });

  it("falls back to the local part rather than rendering a blank name", () => {
    const roster = mergeRoster({
      employees: [],
      members: [member({ id: "m1", email: "jordan.lee@wolfpack.test", name: "" })],
      invites: [],
    });
    expect(roster[0].name).toBe("jordan.lee");
  });
});

describe("ordering", () => {
  it("puts people who can sign in first, then invited, then removed, then no account", () => {
    const roster = mergeRoster({
      employees: [emp({ id: "e1", full_name: "Zoe NoAccount", email: "zoe@wolfpack.test" })],
      members: [
        member({ id: "m1", email: "active@wolfpack.test", name: "Ann Active" }),
        member({ id: "m2", email: "off@wolfpack.test", name: "Bob Removed", is_active: false }),
      ],
      invites: [invite({ id: "i1", email: "inv@wolfpack.test" })],
    });
    expect(roster.map((r) => r.access)).toEqual(["active", "invited", "revoked", "none"]);
  });

  it("sorts by name within the same access state", () => {
    const roster = mergeRoster({
      employees: [],
      members: [
        member({ id: "m1", email: "b@wolfpack.test", name: "Bea" }),
        member({ id: "m2", email: "a@wolfpack.test", name: "Ada" }),
      ],
      invites: [],
    });
    expect(roster.map((r) => r.name)).toEqual(["Ada", "Bea"]);
  });
});

describe("summarizeRoster", () => {
  it("counts each state", () => {
    const roster = mergeRoster({
      employees: [emp({ id: "e1", full_name: "No Account", email: "n@wolfpack.test" })],
      members: [
        member({ id: "m1", email: "a@wolfpack.test" }),
        member({ id: "m2", email: "b@wolfpack.test" }),
        member({ id: "m3", email: "c@wolfpack.test", is_active: false }),
      ],
      invites: [invite({ id: "i1", email: "i@wolfpack.test" })],
    });
    expect(summarizeRoster(roster)).toEqual({
      total: 5,
      active: 2,
      invited: 1,
      revoked: 1,
      no_access: 1,
    });
  });
});
