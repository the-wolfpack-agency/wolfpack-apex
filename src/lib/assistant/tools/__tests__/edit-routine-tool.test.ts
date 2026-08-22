/**
 * Editing a chain from a sentence.
 *
 * Two things here can hurt somebody: an edit that breaks the step order and is
 * only discovered the next morning, and an edit to a BUILT-IN routine that
 * quietly makes a documented command mean something different for one person.
 * Both are refused.
 */
import { editRoutineTool, matchEditIntent } from "../edit-routine-tool";
import "../index";

jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

const mockPending = jest.fn();
jest.mock("../pending-actions", () => ({
  savePendingAction: (...a: unknown[]) => mockPending(...a),
  detectConfirmationIntent: () => "none",
}));
jest.mock("@/lib/assistant/routines/saved", () => {
  const actual = jest.requireActual("@/lib/assistant/routines/saved");
  return { ...actual, matchSavedRoutine: async () => null };
});

const ctx = { userId: "u1", userRole: "cto", workspaceId: "w1" };
const run = (params: Record<string, unknown>) =>
  editRoutineTool.handler(params as never, ctx as never);

beforeEach(() => {
  jest.clearAllMocks();
  mockPending.mockResolvedValue({ id: "p1", description: "d" });
});

describe("reading the instruction", () => {
  it.each([
    ["show me the steps in run my morning", "show"],
    ["remove step 3 from run my morning", "remove"],
    ["move step 4 to 1 in run my morning", "move"],
    ["use search_mail for step 2 in run my morning", "replace"],
  ])("reads %p", (text, action) => {
    expect(matchEditIntent(text)).toMatchObject({ action, command: "run my morning" });
  });

  it("leaves an ordinary run alone", () => {
    expect(matchEditIntent("run my morning")).toBeNull();
  });

  it("does not fire on a question about steps", () => {
    expect(matchEditIntent("how many steps does this have")).toBeNull();
  });
});

describe("showing somebody their chain", () => {
  it("numbers the steps and says how to change them", async () => {
    const res = await run({ command: "run my morning", action: "show" });
    if (!res.ok) throw new Error("expected success");
    expect(res.answer).toMatch(/^1\. /m);
    expect(res.answer).toMatch(/remove step 3 from run my morning/);
  });

  it("says so when there is no such routine", async () => {
    const res = await run({ command: "run the widgets", action: "show" });
    expect(res.ok).toBe(false);
    expect((res as { message: string }).message).toMatch(/do not have a routine called/i);
  });
});

describe("refusing an edit that would break the chain", () => {
  it("will not remove a step a later one reads from", async () => {
    /* run my morning: step 1 writes the agenda, step 4 reads it. Removing
       step 1 would fail tomorrow, not today. */
    const res = await run({ command: "run my morning", action: "remove", position: 1 });
    expect(res.ok).toBe(false);
    expect((res as { message: string }).message).toMatch(/reads what that one produces/i);
    expect(mockPending).not.toHaveBeenCalled();
  });

  it("will not reorder into an order that reads before it writes", async () => {
    const res = await run({ command: "run my morning", action: "move", position: 4, to: 1 });
    expect(res.ok).toBe(false);
    expect((res as { message: string }).message).toMatch(/before the one that produces/i);
  });

  it("gives a reason somebody can act on, never just 'invalid'", async () => {
    const res = await run({ command: "run my morning", action: "replace", position: 1, tool: "imaginary" });
    expect(res.ok).toBe(false);
    expect((res as { message: string }).message).toMatch(/not something I can run/i);
  });
});

describe("editing a built-in", () => {
  it("saves the change as the person's OWN copy", async () => {
    /* Changing a documented command for one person would mean the docs
       describe something they do not have. */
    /* Step 5 is the human step nothing else depends on. Steps 1 to 3 all feed
       the model step, so removing any of them is correctly refused above. */
    const res = await run({ command: "run my morning", action: "remove", position: 5 });
    if (!res.ok) throw new Error(`expected success: ${(res as { message: string }).message}`);
    expect(res.data.command).toBe("my run my morning");
    expect(res.answer).toMatch(/leaves the original alone/i);
  });

  it("offers the change rather than saving it", async () => {
    /* Nothing is written until they agree, through the same path every other
       action uses. */
    await run({ command: "run my morning", action: "remove", position: 5 });
    expect(mockPending).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "save_routine" }),
    );
  });

  it("shows the chain as it would become", async () => {
    const res = await run({ command: "run my morning", action: "remove", position: 5 });
    if (!res.ok) throw new Error("expected success");
    expect(res.answer).toMatch(/Removed "/);
    expect(res.answer).toMatch(/^1\. /m);
  });
});
