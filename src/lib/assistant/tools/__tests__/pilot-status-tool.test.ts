/**
 * pilot_status: the intent surface, the answer, and what it emits.
 *
 * Two things are being defended here. First, that the sentences a client
 * actually says reach this tool and the sentences about somebody's personal
 * to-do list do not, because a wrong tool answering confidently is rated worse
 * than no tool answering at all. Second, that a dark source is visible in
 * every direction the tool speaks: the sentence, the widget, and the analytics
 * row. A dark source that reaches the widget but is rounded to zero in
 * analytics produces a dashboard that disagrees with the product.
 */

const mockTrackEvent = jest.fn();
const mockReadPilotStatus = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/pilot/status", () => ({
  ...jest.requireActual("@/lib/pilot/status-shape"),
  DEFAULT_WINDOW_DAYS: 14,
  readPilotStatus: (...a: unknown[]) => mockReadPilotStatus(...a),
}));

import { pilotStatusTool } from "@/lib/assistant/tools/pilot-status-tool";
import type { PilotStatusWidgetSpec } from "@/lib/assistant/widgets/types";

const match = (q: string) => pilotStatusTool.matchIntent!(q);
const CTX = { userId: "u1", userRole: "cto", timeZone: "America/New_York" };
const NOW = Date.parse("2026-08-26T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function reading(over: Record<string, unknown> = {}) {
  return {
    takenAt: new Date(NOW).toISOString(),
    windowDays: 14,
    calendar: {
      state: "ok",
      detail: null,
      items: [
        {
          id: "m1",
          subject: "Pilot review",
          start: new Date(NOW + 2 * DAY).toISOString(),
          attendees: [],
          minutesUntil: 2880,
        },
      ],
    },
    documents: {
      state: "ok",
      detail: null,
      items: [
        { id: "d1", filename: "SOW.pdf", createdAt: new Date(NOW - DAY).toISOString(), indexed: true },
      ],
    },
    tasks: {
      state: "ok",
      detail: null,
      items: [{ id: "t1", title: "Draft", dueAt: null, overdue: false, completed: false }],
    },
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReadPilotStatus.mockResolvedValue(reading());
});

describe("the sentences a client says", () => {
  test.each([
    /* The three the routing audit measured as reaching nothing. */
    "what's blocking the pilot",
    "how is the pilot going",
    "what's left to do",
    /* Progress, in the words people use. */
    "how's the project going",
    "how are we tracking",
    "how is it going",
    "how are things going",
    "where are we on the pilot",
    "where do we stand",
    "how are we doing on the rollout",
    "are we on track",
    "are we behind",
    /* Blockers. */
    "what's blocking us",
    "what are the blockers",
    "what's in our way",
    "what's at risk",
    "what's holding us up",
    /* Status nouns and updates. */
    "pilot status",
    "status of the engagement",
    "give me a status update on the pilot",
    "update on the project",
    /* Remaining, scoped to an engagement. */
    "what's outstanding on the pilot",
    "what's still left on the project",
  ])("'%s' matches", (q) => {
    expect(match(q)).not.toBeNull();
  });

  it("defaults to the fortnight window", () => {
    expect(match("how is the pilot going")).toEqual({ windowDays: 14 });
  });
});

describe("the sentences that are not for it", () => {
  /* A status tool that eats these becomes the reason somebody stops trusting
     the assistant, because each has a right answer somewhere else. */
  test.each([
    /* Somebody's own to-do list. Belongs to task_list_widget. */
    "what are my tasks",
    "anything overdue",
    "what's on my plate",
    "my tasks",
    /* Money. Belongs to the financials tool, and warranty is not ARR. */
    "what did we bill Porsche",
    "how much revenue this month",
    /* A person. */
    "who is Ashley",
    "who works on the Porsche account",
    /* A document. */
    "what does the SOW say",
    /* The day planner. */
    "plan my day",
    "brief me",
    /* Bare greetings and bare nouns must not drag in a whole status read. */
    "hello",
    "status",
    "update",
    "how are you",
  ])("'%s' does not match", (q) => {
    expect(match(q)).toBeNull();
  });
});

describe("the answer", () => {
  it("joins three sources and says so", async () => {
    const res = await pilotStatusTool.handler({ windowDays: 14 }, CTX);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const spec = res.widget as PilotStatusWidgetSpec;
    expect(spec.kind).toBe("pilot_status");
    expect(spec.readiness).toBe("on_track");
    expect(spec.sources.map((s) => s.source)).toEqual(["calendar", "documents", "tasks"]);
    expect(spec.sources.every((s) => s.state === "ok")).toBe(true);
    expect(spec.nextCheckpoint?.subject).toBe("Pilot review");
    expect(res.answer).toMatch(/^On track:/);
  });

  it("formats the checkpoint in the reader's zone", async () => {
    /* The tool context carries a time zone precisely because a Vercel function
       runs in UTC and would otherwise read four hours out. */
    const res = await pilotStatusTool.handler({ windowDays: 14 }, CTX);
    if (!res.ok) return;
    const ny = (res.widget as PilotStatusWidgetSpec).nextCheckpoint!.when;
    const utc = await pilotStatusTool.handler({ windowDays: 14 }, { ...CTX, timeZone: "UTC" });
    if (!utc.ok) return;
    expect(ny).not.toEqual((utc.widget as PilotStatusWidgetSpec).nextCheckpoint!.when);
  });

  it("leads with the cross-source blocker when work is overdue before a checkpoint", async () => {
    mockReadPilotStatus.mockResolvedValue(
      reading({
        tasks: {
          state: "ok",
          detail: null,
          items: [
            { id: "t1", title: "Draft", dueAt: new Date(NOW - DAY).toISOString(), overdue: true, completed: false },
          ],
        },
      }),
    );
    const res = await pilotStatusTool.handler({ windowDays: 14 }, CTX);
    if (!res.ok) return;
    const spec = res.widget as PilotStatusWidgetSpec;
    expect(spec.readiness).toBe("blocked");
    expect(spec.signals[0].id).toBe("overdue-before-checkpoint");
    expect(spec.signals[0].sources).toEqual(["calendar", "tasks"]);
    expect(res.data).toMatchObject({ crossSourceSignalCount: expect.any(Number) });
    expect((res.data as { crossSourceSignalCount: number }).crossSourceSignalCount).toBeGreaterThan(0);
  });
});

describe("a dark source is visible in every direction the tool speaks", () => {
  const withDarkTasks = () =>
    reading({
      tasks: { state: "unavailable", detail: "The task store read failed: timeout", items: [] },
    });

  it("shows null, never zero, in the widget", async () => {
    mockReadPilotStatus.mockResolvedValue(withDarkTasks());
    const res = await pilotStatusTool.handler({ windowDays: 14 }, CTX);
    if (!res.ok) return;
    const spec = res.widget as PilotStatusWidgetSpec;
    const tasks = spec.sources.find((s) => s.source === "tasks")!;
    expect(tasks.count).toBeNull();
    expect(tasks.state).toBe("unavailable");
    expect(tasks.detail).toContain("timeout");
  });

  it("says so in the spoken answer, not only in the widget", async () => {
    mockReadPilotStatus.mockResolvedValue(withDarkTasks());
    const res = await pilotStatusTool.handler({ windowDays: 14 }, CTX);
    if (!res.ok) return;
    expect(res.answer).toMatch(/tasks unavailable/i);
    expect(res.answer).toMatch(/partial view/i);
  });

  it("says so in the subtitle, in the words 'unknown rather than zero'", async () => {
    mockReadPilotStatus.mockResolvedValue(withDarkTasks());
    const res = await pilotStatusTool.handler({ windowDays: 14 }, CTX);
    if (!res.ok) return;
    expect((res.widget as PilotStatusWidgetSpec).subtitle).toMatch(/unknown rather than zero/i);
  });

  it("emits 'unknown' rather than 0 to analytics", async () => {
    /* THE ONE THAT OUTLIVES THE INCIDENT. A widget corrected today is fixed;
       an analytics series that recorded a dead task store as zero open tasks
       is a wrong number in a dashboard nobody re-derives. */
    mockReadPilotStatus.mockResolvedValue(withDarkTasks());
    await pilotStatusTool.handler({ windowDays: 14 }, CTX);
    const [, , , meta] = mockTrackEvent.mock.calls[0];
    expect(meta.open_tasks).toBe("unknown");
    expect(meta.overdue_tasks).toBe("unknown");
    expect(meta.dark_sources).toBe("tasks");
    expect(meta.dark_source_count).toBe(1);
    expect(meta.readable_sources).toBe("calendar,documents");
  });

  it("refuses a verdict when only one source answered", async () => {
    mockReadPilotStatus.mockResolvedValue(
      reading({
        calendar: { state: "not_connected", detail: "Microsoft 365 is not connected.", items: [] },
        documents: { state: "unavailable", detail: "The Brain read failed: down", items: [] },
        tasks: { state: "ok", detail: null, items: [] },
      }),
    );
    const res = await pilotStatusTool.handler({ windowDays: 14 }, CTX);
    if (!res.ok) return;
    const spec = res.widget as PilotStatusWidgetSpec;
    expect(spec.readiness).toBe("unknown");
    expect(spec.title).toBe("Not enough signal");
    /* Zero open tasks, and it still does not say on track. */
    expect(spec.sources.find((s) => s.source === "tasks")!.count).toBe(0);
    expect(res.answer).not.toMatch(/on track/i);
  });

  it("still emits an event when every source is dark", async () => {
    /* A tool that goes quiet exactly when everything is broken is a tool the
       learning loop cannot see failing. */
    mockReadPilotStatus.mockResolvedValue(
      reading({
        calendar: { state: "unavailable", detail: "a", items: [] },
        documents: { state: "unavailable", detail: "b", items: [] },
        tasks: { state: "unavailable", detail: "c", items: [] },
      }),
    );
    const res = await pilotStatusTool.handler({ windowDays: 14 }, CTX);
    expect(res.ok).toBe(true);
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    const [event, , , meta] = mockTrackEvent.mock.calls[0];
    expect(event).toBe("assistant.widget_offered");
    expect(meta.readable_sources).toBe("none");
    expect(meta.dark_source_count).toBe(3);
    expect(meta.readiness).toBe("unknown");
  });
});

describe("wiring", () => {
  it("reads for the owner when an agent is acting on their behalf", async () => {
    await pilotStatusTool.handler({ windowDays: 14 }, { ...CTX, onBehalfOfUserId: "owner-9" });
    expect(mockReadPilotStatus).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner-9" }));
  });

  it("is a read-only tool available to any authenticated user", () => {
    expect(pilotStatusTool.capability).toBe("*");
    expect(pilotStatusTool.requiresConfirmation).toBeFalsy();
    expect(pilotStatusTool.agentOnly).toBeFalsy();
  });

  it("is registered under the name the tests and the audit use", async () => {
    await import("@/lib/assistant/tools");
    const { getToolByName } = await import("@/lib/assistant/tools/registry");
    expect(getToolByName("pilot_status")).not.toBeNull();
  });

  it("never emits an em dash", async () => {
    mockReadPilotStatus.mockResolvedValue(reading({
      tasks: { state: "unavailable", detail: "The task store read failed: timeout", items: [] },
    }));
    const res = await pilotStatusTool.handler({ windowDays: 14 }, CTX);
    if (!res.ok) return;
    const spec = res.widget as PilotStatusWidgetSpec;
    const text = [res.answer, spec.title, spec.subtitle ?? "", ...spec.signals.flatMap((s) => [s.title, s.detail])];
    for (const t of text) expect(t).not.toContain("—");
  });
});
