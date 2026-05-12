 
const mockWriteQuery = jest.fn();
jest.mock("@/lib/db", () => {
  const actual = jest.requireActual("@/lib/db");
  return {
    ...actual,
    writeQuery: (...a: any[]) => mockWriteQuery(...a),
  };
});

import {
  canReadTeamEvidence,
  applyMemberScope,
  recordEvidenceView,
} from "@/lib/principles/authz";

beforeEach(() => mockWriteQuery.mockReset());

describe("canReadTeamEvidence", () => {
  test("ceo + cto roles return true (case-insensitive)", () => {
    expect(canReadTeamEvidence({ id: "u1", role: "ceo" })).toBe(true);
    expect(canReadTeamEvidence({ id: "u1", role: "CTO" })).toBe(true);
  });
  test("everyone else returns false", () => {
    for (const r of ["sales", "ops", "dev", "hr", "manager", "", "admin"]) {
      expect(canReadTeamEvidence({ id: "u1", role: r })).toBe(false);
    }
  });
});

describe("applyMemberScope", () => {
  test("members get subject_user_id = $N + their id", () => {
    const out = applyMemberScope({ id: "u1", role: "sales" }, 1);
    expect(out.where).toBe("subject_user_id = $1");
    expect(out.params).toEqual(["u1"]);
  });
  test("leadership gets WHERE TRUE + zero params", () => {
    const out = applyMemberScope({ id: "u1", role: "ceo" }, 1);
    expect(out.where).toBe("TRUE");
    expect(out.params).toEqual([]);
  });
  test("paramIndex flows through into the placeholder", () => {
    const out = applyMemberScope({ id: "u1", role: "sales" }, 7);
    expect(out.where).toBe("subject_user_id = $7");
  });
});

describe("recordEvidenceView", () => {
  test("non-leadership viewers never write an audit row", async () => {
    await recordEvidenceView({
      viewer: { id: "u1", role: "sales" },
      subjectUserId: "u2",
      route: "/x",
      evidenceCount: 3,
    });
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });
  test("leadership self-view (subject == viewer) is not audited", async () => {
    await recordEvidenceView({
      viewer: { id: "u1", role: "ceo" },
      subjectUserId: "u1",
      route: "/x",
      evidenceCount: 3,
    });
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });
  test("leadership cross-user view writes the audit row", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    await recordEvidenceView({
      viewer: { id: "u-ceo", role: "ceo" },
      subjectUserId: "u-other",
      route: "/api/principles/team",
      evidenceCount: 12,
    });
    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    expect(mockWriteQuery.mock.calls[0][1]).toEqual([
      "u-ceo",
      "ceo",
      "u-other",
      "/api/principles/team",
      12,
    ]);
  });
  test("leadership cross-team view (subjectUserId null) is audited", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    await recordEvidenceView({
      viewer: { id: "u-ceo", role: "ceo" },
      subjectUserId: null,
      route: "/api/principles/team",
      evidenceCount: 50,
    });
    expect(mockWriteQuery).toHaveBeenCalled();
  });
  test("write failure does not throw — read isn't blocked", async () => {
    mockWriteQuery.mockRejectedValueOnce(new Error("db down"));
    await expect(
      recordEvidenceView({
        viewer: { id: "u1", role: "ceo" },
        subjectUserId: "u2",
        route: "/x",
        evidenceCount: 1,
      }),
    ).resolves.toBeUndefined();
  });
});
