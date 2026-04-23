import { fanoutToTeam, actorLabel } from "../team-fanout";

jest.mock("@/lib/db", () => ({
  safeQuery: jest.fn(),
}));
jest.mock("@/lib/notifications/in-app", () => ({
  notify: jest.fn(),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

const { safeQuery } = jest.requireMock("@/lib/db");
const { notify } = jest.requireMock("@/lib/notifications/in-app");
const { trackEvent } = jest.requireMock("@/lib/analytics");

const baseInput = () => ({
  actor: { id: "u-ceo", role: "ceo", name: "Nick", email: "ceo@wolfpack.dev" },
  title: "New OKR: Ship v2",
  body: "Nick (CEO) added a new OKR",
  actionUrl: "/goals",
  category: "goals" as const,
  source: "instinct.goals",
  sourceId: "okr-1",
  analyticsEvent: "goals.team_notified" as const,
});

describe("fanoutToTeam", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("delivers one notification per active teammate and tracks recipient_count", async () => {
    safeQuery.mockResolvedValue({
      rows: [{ id: "u-a" }, { id: "u-b" }, { id: "u-c" }],
    });
    notify.mockResolvedValue({ ok: true });

    const result = await fanoutToTeam(baseInput());

    expect(notify).toHaveBeenCalledTimes(3);
    expect(result.recipientCount).toBe(3);
    expect(result.skipped).toBe(0);
    expect(trackEvent).toHaveBeenCalledWith(
      "goals.team_notified",
      "u-ceo",
      "ceo",
      expect.objectContaining({ recipient_count: 3, actor_role: "ceo" }),
    );
  });

  it("excludeActor skips the caller row", async () => {
    safeQuery.mockResolvedValue({
      rows: [{ id: "u-ceo" }, { id: "u-b" }],
    });
    notify.mockResolvedValue({ ok: true });

    const result = await fanoutToTeam({ ...baseInput(), excludeActor: true });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-b" }));
    expect(result.recipientCount).toBe(1);
  });

  it("per-recipient failure is swallowed and counted as skipped", async () => {
    safeQuery.mockResolvedValue({ rows: [{ id: "u-a" }, { id: "u-b" }] });
    notify
      .mockRejectedValueOnce(new Error("prefs read failed"))
      .mockResolvedValueOnce({ ok: true });

    const result = await fanoutToTeam(baseInput());

    expect(result.recipientCount).toBe(1);
    expect(result.skipped).toBe(1);
    expect(trackEvent).toHaveBeenCalledWith(
      "goals.team_notified",
      "u-ceo",
      "ceo",
      expect.objectContaining({ recipient_count: 1 }),
    );
  });

  it("db error: no throw, no event fired", async () => {
    safeQuery.mockRejectedValue(new Error("pg down"));

    const result = await fanoutToTeam(baseInput());

    expect(result.recipientCount).toBe(0);
    expect(notify).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("stamps actor_id + actor_role into each notification's metadata", async () => {
    safeQuery.mockResolvedValue({ rows: [{ id: "u-a" }] });
    notify.mockResolvedValue({ ok: true });

    await fanoutToTeam({
      ...baseInput(),
      metadata: { goal_type: "okr", action: "created", okr_id: "okr-1" },
    });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          goal_type: "okr",
          action: "created",
          okr_id: "okr-1",
          actor_id: "u-ceo",
          actor_role: "ceo",
        }),
      }),
    );
  });
});

describe("actorLabel", () => {
  it("prefers name, falls back to email, then id", () => {
    expect(actorLabel({ id: "x", role: "ceo", name: "Nick", email: "n@w" })).toBe("Nick");
    expect(actorLabel({ id: "x", role: "ceo", name: null, email: "n@w" })).toBe("n@w");
    expect(actorLabel({ id: "x", role: "ceo", name: null, email: null })).toBe("x");
  });
});
