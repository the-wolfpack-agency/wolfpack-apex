/**
 * Phase one, as the client will see it.
 *
 * The figures on this page are the argument the product is sold on, so the
 * tests are almost entirely about the ways a figure can mislead. Every one of
 * these has a real precedent in this codebase: a rate rendered over an empty
 * denominator, a failed read rendered as a zero, a claim shown without the
 * volume it was measured against.
 */
const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));

import {
  getPhaseOneSnapshot,
  deterministicShare,
  answersGiven,
  type PhaseOneSnapshot,
} from "../phase-one";

const SNAP = (o: Partial<PhaseOneSnapshot> = {}): PhaseOneSnapshot => ({
  passages: 4769,
  libraries: 6,
  toolAnswers: 3268,
  modelAnswers: 437,
  declined: 49,
  readable: true,
  ...o,
});

/* Every query on this page is workspace-scoped, which the repo-wide tenancy
   scan insisted on: a bare count over instinct_sharepoint_sources reads every
   tenant's connected libraries, and on a single-tenant deployment that is
   harmless in a way that would have survived review. */
const WS = "ws-1";

beforeEach(() => mockQuery.mockReset());

describe("the number the product is sold on", () => {
  it("is the share answered without a model", () => {
    const share = deterministicShare(SNAP());
    expect(share).toBeCloseTo(3268 / 3705, 4);
    expect(Math.round((share ?? 0) * 100)).toBe(88);
  });

  /* Zero would read as "a model answered everything", which is the exact
     opposite of the claim this figure exists to make. */
  it("is null, never zero, when nothing was asked", () => {
    expect(deterministicShare(SNAP({ toolAnswers: 0, modelAnswers: 0 }))).toBeNull();
  });

  it("is one when no question ever reached a model", () => {
    expect(deterministicShare(SNAP({ toolAnswers: 10, modelAnswers: 0 }))).toBe(1);
  });

  it("counts every answer however it was produced", () => {
    expect(answersGiven(SNAP())).toBe(3705);
  });
});

describe("reading the snapshot", () => {
  function respond(passages: string, libraries: string, activity: Record<string, string>) {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ passages }] })
      .mockResolvedValueOnce({ rows: [{ libraries }] })
      .mockResolvedValueOnce({ rows: [activity] });
  }

  it("reports what it read", async () => {
    respond("4769", "6", { tool_answers: "3268", model_answers: "437", declined: "49" });
    const s = await getPhaseOneSnapshot(WS, 60);
    expect(s).toMatchObject({ passages: 4769, libraries: 6, declined: 49, readable: true });
  });

  it("scopes the library count to one workspace", async () => {
    respond("10", "2", { tool_answers: "1", model_answers: "1", declined: "0" });
    await getPhaseOneSnapshot(WS, 60);
    const libCall = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes("instinct_sharepoint_sources"),
    );
    expect(String(libCall![0])).toMatch(/workspace_id = \$1/);
    expect(libCall![1]).toEqual([WS]);
  });

  it("clamps the window rather than scanning every event ever recorded", async () => {
    respond("0", "0", { tool_answers: "0", model_answers: "0", declined: "0" });
    await getPhaseOneSnapshot(WS, 99999);
    const activityCall = mockQuery.mock.calls.find((c) => String(c[0]).includes("FILTER"));
    expect(activityCall![1]).toEqual([365]);
  });
});

describe("when the figures cannot be read", () => {
  /* THE ONE THAT MATTERS MOST. Rendering zeros here claims an empty corpus and
     a silent assistant: a more alarming statement than the truth, and a false
     one. Unreadable and quiet must never look alike. */
  it("says so rather than reporting an empty corpus", async () => {
    mockQuery.mockRejectedValue(new Error("db down"));
    const s = await getPhaseOneSnapshot(WS, 60);
    expect(s.readable).toBe(false);
    expect(s.passages).toBe(0);
  });

  it("does not let an unreadable snapshot imply a deterministic share", async () => {
    mockQuery.mockRejectedValue(new Error("db down"));
    const s = await getPhaseOneSnapshot(WS, 60);
    /* No answers read means no denominator, so no percentage to show. */
    expect(deterministicShare(s)).toBeNull();
  });
});
