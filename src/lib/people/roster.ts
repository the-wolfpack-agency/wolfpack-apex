/**
 * The roster: one row per person, whether they are an employee record, an
 * account, or both.
 *
 * WHY THIS EXISTS
 *
 * /hr listed `apex_employees` only, which is the HR record somebody types in by
 * hand. Access lives in `instinct_team_members`. The two were never joined, so
 * the Employees tab had an "Invite to Instinct" button whose results it could
 * not show: you invited a person, they got access, and they never appeared.
 * Nobody could see who could sign in, and there was no way to take access away
 * or give it back.
 *
 * So this merges the two registers on email and reports the access state
 * explicitly, including for people who have an account and no employee record.
 * Those are the ones the old view hid completely, and they are exactly the ones
 * worth seeing.
 *
 * Email is the join key because it is what an invite is addressed to and what
 * `instinct_team_members` uniquely indexes (migration 128, on LOWER(email)).
 * Matching is case-insensitive for the same reason.
 */

export type AccessState =
  /** Has an account and can sign in. */
  | "active"
  /** Had an account; access was taken away. Restorable. */
  | "revoked"
  /** Invited, has not accepted yet. */
  | "invited"
  /** An employee record with no account and no outstanding invite. */
  | "none";

export interface EmployeeInput {
  id: string;
  full_name: string;
  email: string | null;
  role_title: string | null;
  department: string | null;
  status: string;
}

export interface MemberInput {
  id: string;
  email: string;
  name: string;
  role: string;
  is_active: boolean;
  last_login: string | null;
  m365_connected: boolean;
}

export interface InviteInput {
  id: string;
  email: string;
  role: string;
  created_at: string;
}

export interface RosterEntry {
  /** Stable identity for React keys and for addressing a row. */
  key: string;
  name: string;
  email: string | null;
  role_title: string | null;
  department: string | null;
  /** Present when there is an HR record. Drives edit and delete. */
  employee_id: string | null;
  employee_status: string | null;
  /** Present when there is an account. Drives revoke and restore. */
  member_id: string | null;
  /** The account's role, which is what actually governs permissions. */
  account_role: string | null;
  invite_id: string | null;
  access: AccessState;
  last_login: string | null;
  m365_connected: boolean;
}

/** Active first, because "who can get in right now" is the question being asked. */
const ACCESS_ORDER: Record<AccessState, number> = { active: 0, invited: 1, revoked: 2, none: 3 };

/** Falls back to the local part so a row never renders as a blank name. */
function displayName(employeeName: string | null, memberName: string | null, email: string | null): string {
  const named = employeeName?.trim() || memberName?.trim();
  if (named) return named;
  if (email) return email.split("@")[0];
  return "Unnamed";
}

/**
 * Merge the HR records, the accounts and the outstanding invites into one list.
 *
 * Pure. Every rule that decides what somebody's access state is lives here
 * rather than in SQL or in a component, so it can be tested directly.
 */
export function mergeRoster(input: {
  employees: readonly EmployeeInput[];
  members: readonly MemberInput[];
  invites: readonly InviteInput[];
}): RosterEntry[] {
  const { employees, members, invites } = input;
  const byEmail = new Map<string, RosterEntry>();
  const out: RosterEntry[] = [];

  /* An employee with no email cannot be matched to an account, so it gets its
     own row keyed by id. NULL emails are distinct in Postgres too, so several
     such rows can coexist. */
  const place = (email: string | null, entry: RosterEntry): RosterEntry => {
    if (!email) {
      out.push(entry);
      return entry;
    }
    const k = email.toLowerCase();
    const existing = byEmail.get(k);
    if (existing) return existing;
    byEmail.set(k, entry);
    out.push(entry);
    return entry;
  };

  for (const e of employees) {
    place(e.email, {
      key: e.email ? e.email.toLowerCase() : e.id,
      name: displayName(e.full_name, null, e.email),
      email: e.email,
      role_title: e.role_title,
      department: e.department,
      employee_id: e.id,
      employee_status: e.status,
      member_id: null,
      account_role: null,
      invite_id: null,
      access: "none",
      last_login: null,
      m365_connected: false,
    });
  }

  for (const m of members) {
    const entry = place(m.email, {
      key: m.email.toLowerCase(),
      name: displayName(null, m.name, m.email),
      email: m.email,
      role_title: null,
      department: null,
      employee_id: null,
      employee_status: null,
      member_id: m.id,
      account_role: m.role,
      invite_id: null,
      access: "none",
      last_login: null,
      m365_connected: false,
    });
    entry.member_id = m.id;
    entry.account_role = m.role;
    entry.access = m.is_active ? "active" : "revoked";
    entry.last_login = m.last_login;
    entry.m365_connected = m.m365_connected;
    /* The HR record is the better source for a display name: it is what an
       administrator typed, where the member name may have come from an OAuth
       profile. Only fall back when there is no employee record. */
    if (!entry.employee_id) entry.name = displayName(null, m.name, m.email);
  }

  for (const i of invites) {
    const entry = place(i.email, {
      key: i.email.toLowerCase(),
      name: displayName(null, null, i.email),
      email: i.email,
      role_title: null,
      department: null,
      employee_id: null,
      employee_status: null,
      member_id: null,
      account_role: i.role,
      invite_id: i.id,
      access: "invited",
      last_login: null,
      m365_connected: false,
    });
    /* An invite only tells us something about people who have no account yet.
       Somebody who already signed in outranks an invite that was never opened,
       and must not be shown as merely "invited". */
    if (!entry.member_id) {
      entry.invite_id = i.id;
      entry.access = "invited";
      entry.account_role = entry.account_role ?? i.role;
    }
  }

  return out.sort(
    (a, b) => ACCESS_ORDER[a.access] - ACCESS_ORDER[b.access] || a.name.localeCompare(b.name),
  );
}

/** Headline counts for the roster, so the UI does not recompute them per render. */
export function summarizeRoster(entries: readonly RosterEntry[]) {
  return {
    total: entries.length,
    active: entries.filter((e) => e.access === "active").length,
    invited: entries.filter((e) => e.access === "invited").length,
    revoked: entries.filter((e) => e.access === "revoked").length,
    no_access: entries.filter((e) => e.access === "none").length,
  };
}
