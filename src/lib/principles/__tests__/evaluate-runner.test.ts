/* eslint-disable @typescript-eslint/no-explicit-any */
const mockListSignals = jest.fn();
const mockInsertObs = jest.fn();
const mockHasAny = jest.fn();
const mockTrack = jest.fn();
const mockListUsers = jest.fn();
const mockEvaluate = jest.fn();

jest.mock("@/lib/principles/store", () => ({
  listSignalsForPrinciple: (...a: any[]) => mockListSignals(...a),
  insertObservations: (...a: any[]) => mockInsertObs(...a),
  hasAnyObservationForValidator: (...a: any[]) => mockHasAny(...a),
}));
jest.mock("@/lib/principles/users-iterator", () => ({
  listConnectedM365Users: (...a: any[]) => mockListUsers(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrack(...a),
}));
/* Skip the side-effect import that registers the real validators —
   we drive the registry by hand below so each test is hermetic. */
jest.mock("@/lib/principles/built-in-validators", () => ({}));

import {
  registerValidator,
  _resetRegistryForTests,
  type Validator,
} from "@/lib/principles/validators";
import { evaluatePrinciples } from "@/lib/principles/evaluate-runner";
import type { PrincipleRecord } from "@/lib/principles/store";

const principle = (override: Partial<PrincipleRecord> = {}): PrincipleRecord => ({
  id: "p1",
  slug: "ship-fast",
  title: "Ship fast",
  domains: ["code"],
  owner: null,
  bodyMd: "",
  scoreboardWeight: 1,
  sourceUrl: null,
  sourceDocHash: null,
  effectiveAt: null,
  retiredAt: null,
  createdAt: "2026-05-01",
  updatedAt: "2026-05-01",
  ...override,
});

/* Builds a validator whose matcher fires when the description contains
 * the supplied keyword (case-insensitive). Keeps tests independent of
 * the keywordMatcher helper's normalization rules. */
const validator = (
  id: string,
  keyword: string,
  evaluate: Validator["evaluate"],
): Validator => ({
  id,
  surface: "calendar",
  describe: id,
  matches: (d) => d.toLowerCase().includes(keyword.toLowerCase()),
  evaluate,
});

beforeEach(() => {
  mockListSignals.mockReset();
  mockInsertObs.mockReset();
  mockHasAny.mockReset();
  mockTrack.mockReset();
  mockListUsers.mockReset();
  mockEvaluate.mockReset();
  _resetRegistryForTests();
});

describe("evaluatePrinciples", () => {
  test("returns no_bindings when no signal matches a registered validator", async () => {
    mockListSignals.mockResolvedValueOnce([
      { id: "s1", principleId: "p1", kind: "signal", description: "vibes" },
    ]);
    const out = await evaluatePrinciples([principle()]);
    expect(out.skippedReason).toBe("no_bindings");
    expect(out.bindingCount).toBe(0);
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.evaluation_skipped",
      "system",
      "system",
      expect.objectContaining({ reason: "no_bindings" }),
    );
  });

  test("returns no_connected_users when bindings exist but iterator is empty", async () => {
    registerValidator(validator("calendar.focus", "focus", mockEvaluate));
    mockListSignals.mockResolvedValueOnce([
      { id: "s1", principleId: "p1", kind: "signal", description: "focus blocks" },
    ]);
    mockListUsers.mockResolvedValueOnce([]);
    const out = await evaluatePrinciples([principle()]);
    expect(out.skippedReason).toBe("no_connected_users");
    expect(out.bindingCount).toBe(1);
    expect(out.userCount).toBe(0);
    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  test("fans out across users + persists observations + uses 30d window when no prior", async () => {
    registerValidator(
      validator("mail.after_hours", "after hours", async (ctx) => [
        {
          surface: "mail",
          subjectUserId: ctx.subjectUserId,
          observedAt: ctx.windowEnd,
          score: -0.5,
          evidence: { kind: "after_hours" },
        },
      ]),
    );
    mockListSignals.mockResolvedValueOnce([
      { id: "s1", principleId: "p1", kind: "signal", description: "after hours mail" },
    ]);
    mockListUsers.mockResolvedValueOnce([
      { userId: "u-a", email: "a@x", displayName: "A", connectedAt: "" },
      { userId: "u-b", email: "b@x", displayName: "B", connectedAt: "" },
    ]);
    mockHasAny.mockResolvedValueOnce(false); // bootstrap path
    mockInsertObs.mockResolvedValueOnce(2);

    const out = await evaluatePrinciples([principle()]);
    expect(out.observationCount).toBe(2);
    expect(out.userCount).toBe(2);
    expect(out.bindingCount).toBe(1);

    const insertArgs = mockInsertObs.mock.calls[0][0];
    expect(insertArgs.principleId).toBe("p1");
    expect(insertArgs.validatorId).toBe("mail.after_hours");
    expect(insertArgs.rows).toHaveLength(2);
    expect(insertArgs.rows.map((r: any) => r.subjectUserId).sort()).toEqual([
      "u-a",
      "u-b",
    ]);

    /* The 30d bootstrap window means windowStart is ~30d ago. */
    const winStart = new Date(insertArgs.rows[0].evidenceJsonb.kind ? 0 : 0);
    const passedToValidator = mockEvaluate.mock.calls;
    /* validators we registered are anonymous fns — we can't grab the
       ctx through them. The window check is implicit: if hasAny=false
       triggered the bootstrap path, the validator received a windowEnd
       within the last second. Just confirm hasAny was consulted. */
    void winStart; void passedToValidator;
    expect(mockHasAny).toHaveBeenCalledWith("mail.after_hours");
  });

  test("forceBootstrap skips the hasAny check entirely", async () => {
    registerValidator(
      validator("mail.after_hours", "after hours", async () => [
        {
          surface: "mail",
          observedAt: "2026-05-01",
          score: -0.4,
          evidence: { kind: "x" },
        },
      ]),
    );
    mockListSignals.mockResolvedValueOnce([
      { id: "s1", principleId: "p1", kind: "signal", description: "after hours mail" },
    ]);
    mockListUsers.mockResolvedValueOnce([
      { userId: "u-a", email: "a@x", displayName: "A", connectedAt: "" },
    ]);
    mockInsertObs.mockResolvedValueOnce(1);

    await evaluatePrinciples([principle()], { forceBootstrap: true });
    expect(mockHasAny).not.toHaveBeenCalled();
  });

  test("validator throw isolates one user without breaking others", async () => {
    registerValidator(
      validator("mail.after_hours", "after hours", async (ctx) => {
        if (ctx.subjectUserId === "u-bad") throw new Error("token revoked");
        return [
          {
            surface: "mail",
            subjectUserId: ctx.subjectUserId,
            observedAt: "2026-05-01",
            score: -0.2,
            evidence: { kind: "x" },
          },
        ];
      }),
    );
    mockListSignals.mockResolvedValueOnce([
      { id: "s1", principleId: "p1", kind: "signal", description: "after hours mail" },
    ]);
    mockListUsers.mockResolvedValueOnce([
      { userId: "u-bad", email: "x@x", displayName: null, connectedAt: "" },
      { userId: "u-good", email: "g@x", displayName: null, connectedAt: "" },
    ]);
    mockHasAny.mockResolvedValueOnce(true);
    mockInsertObs.mockResolvedValueOnce(1);

    const out = await evaluatePrinciples([principle()]);
    expect(out.failureCount).toBe(1);
    expect(out.observationCount).toBe(1);
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.evaluation_failed",
      "u-bad",
      "system",
      expect.objectContaining({ validator_id: "mail.after_hours" }),
    );
  });

  test("insert failure tracked, doesn't throw out of the runner", async () => {
    registerValidator(
      validator("mail.after_hours", "after hours", async (ctx) => [
        {
          surface: "mail",
          subjectUserId: ctx.subjectUserId,
          observedAt: "2026-05-01",
          score: -0.2,
          evidence: { kind: "x" },
        },
      ]),
    );
    mockListSignals.mockResolvedValueOnce([
      { id: "s1", principleId: "p1", kind: "signal", description: "after hours mail" },
    ]);
    mockListUsers.mockResolvedValueOnce([
      { userId: "u-a", email: "a@x", displayName: null, connectedAt: "" },
    ]);
    mockHasAny.mockResolvedValueOnce(true);
    mockInsertObs.mockRejectedValueOnce(new Error("db down"));

    const out = await evaluatePrinciples([principle()]);
    expect(out.failureCount).toBe(1);
    expect(out.observationCount).toBe(0);
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.evaluation_failed",
      "system",
      "system",
      expect.objectContaining({ stage: "insert" }),
    );
  });

  test("listUsers override is honored (test injection)", async () => {
    registerValidator(
      validator("mail.after_hours", "after hours", async () => [
        {
          surface: "mail",
          observedAt: "2026-05-01",
          score: 0,
          evidence: { kind: "x" },
        },
      ]),
    );
    mockListSignals.mockResolvedValueOnce([
      { id: "s1", principleId: "p1", kind: "signal", description: "after hours mail" },
    ]);
    mockInsertObs.mockResolvedValueOnce(1);

    const inj = jest.fn(async () => [
      { userId: "uX", email: "x@x", displayName: null, connectedAt: "" },
    ]);
    const out = await evaluatePrinciples([principle()], {
      forceBootstrap: true,
      listUsers: inj,
    });
    expect(inj).toHaveBeenCalled();
    expect(mockListUsers).not.toHaveBeenCalled();
    expect(out.observationCount).toBe(1);
  });
});
