/**
 * Standing appointments, from a sentence.
 *
 * The failures worth preventing are all the same shape: something starts
 * happening on its own that the person did not clearly ask for. A guessed time,
 * a schedule pointing at a routine that does not exist, or a cadence read out
 * of a question rather than an instruction.
 *
 * Each one ends the same way: a thing fires at an odd hour forever and nobody
 * connects it back to what they typed.
 */
import { scheduleRoutineTool, matchScheduleIntent } from "../schedule-routine-tool";

jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

const mockUpsert = jest.fn();
const mockCancel = jest.fn();
const mockList = jest.fn();
jest.mock("@/lib/assistant/routines/schedule-store", () => ({
  upsertSchedule: (...a: unknown[]) => mockUpsert(...a),
  cancelSchedule: (...a: unknown[]) => mockCancel(...a),
  listSchedules: (...a: unknown[]) => mockList(...a),
}));
jest.mock("@/lib/assistant/routines/saved", () => ({ matchSavedRoutine: async () => null }));

const ctx = { userId: "u1", userRole: "cto", workspaceId: "w1" };
const run = (params: Record<string, unknown>) =>
  scheduleRoutineTool.handler(params as never, ctx as never);

beforeEach(() => {
  jest.clearAllMocks();
  mockUpsert.mockResolvedValue({ ok: true, nextRunAt: new Date("2026-03-10T12:00:00Z") });
  mockCancel.mockResolvedValue(true);
  mockList.mockResolvedValue([]);
});

describe("reading the instruction", () => {
  it("recognizes a standing appointment", () => {
    /* The command is captured WHOLE, verb included, because the chain is
       called "run my morning" and stripping the verb leaves something that
       matches nothing. */
    expect(matchScheduleIntent("run my morning every weekday at 8am")).toMatchObject({
      action: "create",
      command: "run my morning",
    });
  });

  it("does NOT schedule from a sentence with no time", () => {
    /* "run my morning every weekday" reads as a question about what happens,
       not an instruction to make it happen unattended. */
    expect(matchScheduleIntent("run my morning every weekday")).toBeNull();
  });

  it("recognizes stopping one", () => {
    expect(matchScheduleIntent("stop running my morning")).toMatchObject({ action: "cancel" });
  });

  it("recognizes the question about what is scheduled", () => {
    expect(matchScheduleIntent("what's scheduled")).toEqual({ action: "list" });
    expect(matchScheduleIntent("what runs automatically")).toEqual({ action: "list" });
  });

  it("leaves an ordinary run alone", () => {
    /* Typing the command must still just run it. */
    expect(matchScheduleIntent("run my morning")).toBeNull();
  });
});

describe("refusing to guess", () => {
  it("will not schedule a routine that does not exist", async () => {
    /* Otherwise it fails every morning and they hear about it from a
       notification rather than from the sentence they just typed. */
    const res = await run({ action: "create", command: "run the widgets", text: "every day at 8am" });
    expect(res.ok).toBe(false);
    expect((res as { message: string }).message).toMatch(/do not have a routine called/i);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("asks rather than inventing the missing half of a schedule", async () => {
    const res = await run({ action: "create", command: "run my morning", text: "run my morning sometimes" });
    expect(res.ok).toBe(false);
    expect((res as { message: string }).message).toMatch(/rather ask than guess/i);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe("setting one up", () => {
  it("confirms when, where, and what it will and will not do", async () => {
    const res = await run({
      action: "create",
      command: "run my morning",
      text: "run my morning every weekday at 8am",
    });
    if (!res.ok) throw new Error(`expected success: ${(res as { message: string }).message}`);
    expect(res.answer).toMatch(/every weekday at 8am/i);
    /* The zone is stated so a wrong default is correctable in the next
       sentence rather than silently wrong forever. */
    expect(res.answer).toMatch(/\(.+\/.+\)|\(UTC\)/);
    expect(res.answer).toMatch(/nothing is sent or filed without you confirming it/i);
  });

  it("says it will wait at the steps that are the person's", async () => {
    const res = await run({
      action: "create",
      command: "run my morning",
      text: "run my morning every weekday at 8am",
    });
    if (!res.ok) throw new Error("expected success");
    expect(res.answer).toMatch(/wait for you at/i);
    expect(res.answer).toMatch(/send you the result/i);
  });

  it("finds the routine when somebody drops the verb", async () => {
    /* People say "schedule my morning every weekday"; the chain is called
       "run my morning". Refusing on that is the product being pedantic about
       its own naming at somebody who was perfectly clear. */
    const res = await run({
      action: "create",
      command: "my morning",
      text: "my morning every weekday at 8am",
    });
    if (!res.ok) throw new Error("expected success");
    expect(res.data.command).toBe("run my morning");
  });

  it("stores it under the routine's real command, not the words typed", async () => {
    await run({ action: "create", command: "my morning", text: "my morning every weekday at 8am" });
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.anything(),
      "run my morning",
      expect.objectContaining({ cadence: "weekdays", hour: 8 }),
      expect.anything(),
    );
  });
});

describe("listing and stopping", () => {
  it("says plainly when nothing runs automatically, and how to start", async () => {
    const res = await run({ action: "list" });
    if (!res.ok) throw new Error("expected success");
    expect(res.answer).toMatch(/nothing runs automatically yet/i);
    expect(res.answer).toMatch(/every weekday at 8am/i);
  });

  it("lists what is scheduled with the promise attached", async () => {
    mockList.mockResolvedValue([
      { command: "run my morning", schedule: { cadence: "weekdays", hour: 8, timeZone: "UTC" } },
    ]);
    const res = await run({ action: "list" });
    if (!res.ok) throw new Error("expected success");
    expect(res.answer).toMatch(/run my morning/);
    expect(res.answer).toMatch(/nothing is sent or filed without you confirming it/i);
  });

  it("stops one", async () => {
    const res = await run({ action: "cancel", command: "run my morning" });
    if (!res.ok) throw new Error("expected success");
    expect(res.answer).toMatch(/will not run on its own any more/i);
    expect(res.answer).toMatch(/still run it by name/i);
  });

  it("says so when there was nothing to stop", async () => {
    mockCancel.mockResolvedValue(false);
    const res = await run({ action: "cancel", command: "run my morning" });
    if (!res.ok) throw new Error("expected success");
    expect(res.answer).toMatch(/nothing was scheduled/i);
  });
});
