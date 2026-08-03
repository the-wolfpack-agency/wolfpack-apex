import { pendingInvitesFor, type PendingInviteRow, type TeamMemberRow } from "../directory";

/**
 * The shared "who has access" reader, used by both /api/admin/team-status and
 * the /hr roster. It exists so the two surfaces cannot drift into two different
 * answers to the same question.
 */

const inv = (email: string, id = "i"): PendingInviteRow => ({
  id,
  email,
  role: "ops",
  invited_by: "u",
  created_at: "2026-08-01T00:00:00Z",
  expires_at: null,
});

const mem = (email: string): TeamMemberRow => ({
  id: "m",
  email,
  name: "M",
  role: "ops",
  is_active: true,
  created_at: "2026-07-01T00:00:00Z",
  last_login: null,
  has_password: true,
  m365_connected: false,
});

describe("pendingInvitesFor", () => {
  it("keeps an invite nobody has accepted", () => {
    expect(pendingInvitesFor([inv("a@x.test")], [])).toHaveLength(1);
  });

  it("drops an invite whose address already has an account", () => {
    // Somebody can be invited and then sign in through Microsoft OAuth without
    // ever opening the link. The leftover invite means nothing.
    expect(pendingInvitesFor([inv("a@x.test")], [mem("a@x.test")])).toHaveLength(0);
  });

  it("matches case-insensitively, the way the email index does", () => {
    expect(pendingInvitesFor([inv("Pat@X.Test")], [mem("pat@x.test")])).toHaveLength(0);
  });

  it("keeps a revoked member's address out of the pending list", () => {
    // They have an account, deactivated. That is "access removed", not
    // "invitation outstanding", and the roster reports it as such.
    expect(pendingInvitesFor([inv("a@x.test")], [{ ...mem("a@x.test"), is_active: false }])).toHaveLength(0);
  });
});
