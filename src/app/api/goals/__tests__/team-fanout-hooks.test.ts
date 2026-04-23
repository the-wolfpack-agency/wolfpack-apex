import { NextRequest } from "next/server";

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: jest.fn(),
}));
jest.mock("@/lib/goals", () => ({
  createOKR: jest.fn(),
  updateOKR: jest.fn(),
  archiveOKR: jest.fn(),
  updateKR: jest.fn(),
  updateKRCurrent: jest.fn(),
  deleteKR: jest.fn(),
}));
jest.mock("@/lib/goals-north-star", () => ({
  captureNorthStar: jest.fn(),
  updateNorthStar: jest.fn(),
  deleteNorthStar: jest.fn(),
}));
jest.mock("@/lib/notifications/team-fanout", () => ({
  fanoutToTeam: jest.fn().mockResolvedValue({ recipientCount: 3, skipped: 0 }),
  actorLabel: jest.fn((u) => u.name || u.email || u.id),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

const { getUserFromRequest } = jest.requireMock("@/lib/auth");
const goalsLib = jest.requireMock("@/lib/goals");
const northLib = jest.requireMock("@/lib/goals-north-star");
const { fanoutToTeam } = jest.requireMock("@/lib/notifications/team-fanout");

function req(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ceo = { id: "u-ceo", email: "ceo@w", name: "CEO", role: "ceo" };
const dev = { id: "u-dev", email: "dev@w", name: "Dev", role: "dev" };

describe("goal mutations fan out to the team", () => {
  beforeEach(() => jest.clearAllMocks());

  it("POST /api/goals/okrs fires goals.team_notified with action=created", async () => {
    getUserFromRequest.mockReturnValue(ceo);
    goalsLib.createOKR.mockResolvedValue({
      id: "okr-1",
      quarter: "2026-Q2",
      objective: "Ship v2",
      krs: [{ id: "kr-1" }],
    });
    const { POST } = await import("../okrs/route");
    const res = await POST(
      req("http://t/api/goals/okrs", {
        quarter: "2026-Q2",
        objective: "Ship v2",
        krs: [{ metric: "ARR", target: 1000000 }],
      }),
    );
    expect(res.status).toBe(201);
    expect(fanoutToTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: ceo,
        category: "goals",
        actionUrl: "/goals",
        analyticsEvent: "goals.team_notified",
        analyticsPayload: expect.objectContaining({ goal_type: "okr", action: "created" }),
        excludeActor: true,
      }),
    );
  });

  it("PATCH /api/goals/okrs/[id] fires goals.team_notified with action=updated", async () => {
    getUserFromRequest.mockReturnValue(ceo);
    goalsLib.updateOKR.mockResolvedValue({
      id: "okr-1",
      quarter: "2026-Q2",
      objective: "Ship v2 (revised)",
    });
    const { PATCH } = await import("../okrs/[id]/route");
    const r = new NextRequest("http://t/api/goals/okrs/okr-1", {
      method: "PATCH",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ objective: "Ship v2 (revised)" }),
    });
    const res = await PATCH(r, { params: Promise.resolve({ id: "okr-1" }) });
    expect(res.status).toBe(200);
    expect(fanoutToTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        analyticsPayload: expect.objectContaining({ goal_type: "okr", action: "updated" }),
      }),
    );
  });

  it("POST /api/goals/north-star fires goals.team_notified", async () => {
    getUserFromRequest.mockReturnValue(ceo);
    northLib.captureNorthStar.mockResolvedValue({
      id: "snap-1",
      label: "ARR",
      value: 1200000,
      unit: "$",
    });
    const { POST } = await import("../north-star/route");
    const res = await POST(
      req("http://t/api/goals/north-star", {
        value: 1200000,
        label: "ARR",
        unit: "$",
      }),
    );
    expect(res.status).toBe(201);
    expect(fanoutToTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        analyticsPayload: expect.objectContaining({ goal_type: "north_star", action: "created" }),
      }),
    );
  });

  it("PATCH /api/goals/krs/[id] fanout ONLY fires on admin metadata edit, NOT on progress update", async () => {
    // 1. progress update by a non-admin dev — fanout MUST NOT fire.
    getUserFromRequest.mockReturnValue(dev);
    goalsLib.updateKRCurrent.mockResolvedValue({ id: "kr-1", metric: "ARR", current_value: 50 });
    const { PATCH } = await import("../krs/[id]/route");
    const r1 = new NextRequest("http://t/api/goals/krs/kr-1", {
      method: "PATCH",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ current_value: 50 }),
    });
    const res1 = await PATCH(r1, { params: Promise.resolve({ id: "kr-1" }) });
    expect(res1.status).toBe(200);
    expect(fanoutToTeam).not.toHaveBeenCalled();

    // 2. metadata edit by CEO — fanout fires.
    getUserFromRequest.mockReturnValue(ceo);
    goalsLib.updateKR.mockResolvedValue({ id: "kr-1", metric: "ARR (revised)" });
    const r2 = new NextRequest("http://t/api/goals/krs/kr-1", {
      method: "PATCH",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ metric: "ARR (revised)", target: 2000000 }),
    });
    const res2 = await PATCH(r2, { params: Promise.resolve({ id: "kr-1" }) });
    expect(res2.status).toBe(200);
    expect(fanoutToTeam).toHaveBeenCalledTimes(1);
    expect(fanoutToTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        analyticsPayload: expect.objectContaining({ goal_type: "kr", action: "updated" }),
      }),
    );
  });

  it("PATCH /api/goals/north-star/[id] fires goals.team_notified", async () => {
    getUserFromRequest.mockReturnValue(ceo);
    northLib.updateNorthStar.mockResolvedValue({
      id: "snap-1",
      label: "ARR",
      value: 1300000,
      unit: "$",
    });
    const { PATCH } = await import("../north-star/[id]/route");
    const r = new NextRequest("http://t/api/goals/north-star/snap-1", {
      method: "PATCH",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ value: 1300000 }),
    });
    const res = await PATCH(r, { params: Promise.resolve({ id: "snap-1" }) });
    expect(res.status).toBe(200);
    expect(fanoutToTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        analyticsPayload: expect.objectContaining({ goal_type: "north_star", action: "updated" }),
      }),
    );
  });

  it("non-admin creating an OKR is 403 and does NOT trigger fanout", async () => {
    getUserFromRequest.mockReturnValue(dev);
    const { POST } = await import("../okrs/route");
    const res = await POST(
      req("http://t/api/goals/okrs", {
        quarter: "2026-Q2",
        objective: "Ship v2",
        krs: [{ metric: "ARR", target: 1000000 }],
      }),
    );
    expect(res.status).toBe(403);
    expect(fanoutToTeam).not.toHaveBeenCalled();
  });
});
