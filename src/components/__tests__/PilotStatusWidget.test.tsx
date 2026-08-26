/**
 * @jest-environment jsdom
 *
 * PilotStatusWidget: does the rendered surface tell the truth about what it
 * could not read?
 *
 * The tool can compute a perfectly honest reading and still ship a lie, because
 * the last mile is a column of numbers and an empty column looks the same
 * whether the store was empty or unreachable. That is the whole reason this
 * component test exists separately from the tool test: the failures on
 * 2026-08-26 were not wrong functions, they were correct functions whose
 * output nobody rendered honestly.
 *
 * So these assert the PIXELS: an unreadable source shows the word "unknown"
 * and never the digit 0, keeps its row rather than being filtered away, and
 * the headline refuses to say "on track" over a partial picture.
 */

import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";

const mockFetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { ChatWidget } from "@/components/ChatWidget";
import type { PilotStatusWidgetSpec } from "@/lib/assistant/widgets/types";

function spec(over: Partial<PilotStatusWidgetSpec> = {}): PilotStatusWidgetSpec {
  return {
    kind: "pilot_status",
    title: "On track",
    subtitle: "Joined from calendar, Brain and tasks over the last 14 days.",
    readiness: "on_track",
    readinessLabel: "On track",
    windowDays: 14,
    takenAt: "2026-08-26T12:00:00.000Z",
    sources: [
      { source: "calendar", state: "ok", count: 3, detail: "3 meetings in the next 14 days" },
      { source: "documents", state: "ok", count: 2, detail: "2 landed in the Brain in the last 14 days" },
      { source: "tasks", state: "ok", count: 5, detail: "5 open" },
    ],
    signals: [
      {
        id: "overdue-before-checkpoint",
        tone: "blocker",
        title: "2 overdue tasks before Pilot review",
        detail: "Pilot review is Thu, Aug 28 at 10:00 and 2 items are already past due.",
        sources: ["calendar", "tasks"],
      },
    ],
    nextCheckpoint: { subject: "Pilot review", when: "Thu, Aug 28, 10:00 AM" },
    ...over,
  };
}

beforeEach(() => mockFetch.mockClear());

describe("the happy render", () => {
  it("renders through the ChatWidget dispatcher, not just in isolation", () => {
    /* A renderer that works standalone and is missing from the switch ships a
       tool that emits a widget nobody ever sees. That exact bug hid the
       TimeLogWidget for two months. */
    render(<ChatWidget spec={spec()} />);
    expect(screen.getByTestId("pilot-status-widget")).toBeInTheDocument();
  });

  it("shows the headline, the three systems and the next checkpoint", () => {
    render(<ChatWidget spec={spec()} />);
    expect(screen.getByTestId("pilot-status-headline")).toHaveTextContent("On track");
    for (const s of ["calendar", "documents", "tasks"]) {
      expect(screen.getByTestId(`pilot-status-source-${s}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("pilot-status-next-checkpoint")).toHaveTextContent("Pilot review");
  });

  it("badges a cross-source signal with both of the systems it came from", () => {
    render(<ChatWidget spec={spec()} />);
    const row = screen.getByTestId("pilot-status-signal-overdue-before-checkpoint");
    expect(within(row).getByText("Calendar")).toBeInTheDocument();
    expect(within(row).getByText("Tasks")).toBeInTheDocument();
    expect(row).toHaveAttribute("data-tone", "blocker");
  });

  it("reports the render to analytics so offered-versus-rendered is measurable", () => {
    render(<ChatWidget spec={spec()} />);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.event).toBe("assistant.widget_rendered");
    expect(body.metadata).toMatchObject({ widget_kind: "pilot_status", readiness: "on_track" });
  });
});

describe("an unreadable source never renders as a zero", () => {
  const darkTasks = () =>
    spec({
      title: "Not enough signal",
      readiness: "unknown",
      readinessLabel: "Not enough signal",
      subtitle:
        "Joined from 2 of 3 systems over the last 14 days. tasks unavailable, so counts from it are unknown rather than zero.",
      sources: [
        { source: "calendar", state: "ok", count: 3, detail: "3 meetings in the next 14 days" },
        { source: "documents", state: "ok", count: 0, detail: "0 landed in the Brain in the last 14 days" },
        { source: "tasks", state: "unavailable", count: null, detail: "The task store read failed: timeout" },
      ],
      signals: [
        {
          id: "dark-tasks",
          tone: "dark",
          title: "tasks could not be read",
          detail: "The task store read failed: timeout",
          sources: ["tasks"],
        },
      ],
    });

  it("shows the word unknown, not a digit", () => {
    render(<ChatWidget spec={darkTasks()} />);
    const cell = screen.getByTestId("pilot-status-count-tasks");
    expect(cell).toHaveTextContent("unknown");
    expect(cell).not.toHaveTextContent("0");
  });

  it("keeps a genuine zero as a zero on the source that answered", () => {
    /* The other half of the contract. If everything unreadable became a word
       and everything empty became a word too, the widget would be honest and
       useless. A source that answered zero says zero. */
    render(<ChatWidget spec={darkTasks()} />);
    expect(screen.getByTestId("pilot-status-count-documents")).toHaveTextContent("0");
  });

  it("keeps the dark source's row instead of hiding it", () => {
    render(<ChatWidget spec={darkTasks()} />);
    const row = screen.getByTestId("pilot-status-source-tasks");
    expect(row).toHaveAttribute("data-state", "unavailable");
    expect(screen.getByTestId("pilot-status-state-tasks")).toHaveTextContent("not read");
  });

  it("does not claim on track over a partial picture", () => {
    render(<ChatWidget spec={darkTasks()} />);
    expect(screen.getByTestId("pilot-status-headline")).toHaveTextContent("Not enough signal");
    expect(screen.getByTestId("pilot-status-widget")).toHaveAttribute("data-readiness", "unknown");
    expect(screen.getByTestId("pilot-status-subtitle")).toHaveTextContent("unknown rather than zero");
  });

  it("counts the systems that answered in the corner, not all three", () => {
    render(<ChatWidget spec={darkTasks()} />);
    expect(screen.getByText("2/3 systems")).toBeInTheDocument();
  });

  it("distinguishes not connected from could not be read", () => {
    render(
      <ChatWidget
        spec={spec({
          sources: [
            { source: "calendar", state: "not_connected", count: null, detail: "Microsoft 365 is not connected." },
            { source: "documents", state: "ok", count: 2, detail: "2 landed" },
            { source: "tasks", state: "unavailable", count: null, detail: "timeout" },
          ],
        })}
      />,
    );
    expect(screen.getByTestId("pilot-status-state-calendar")).toHaveTextContent("not connected");
    expect(screen.getByTestId("pilot-status-state-tasks")).toHaveTextContent("not read");
  });
});

describe("degenerate specs do not break the chat", () => {
  it("renders the empty-signal state rather than a bare box", () => {
    render(<ChatWidget spec={spec({ signals: [] })} />);
    expect(screen.getByTestId("pilot-status-no-signals")).toBeInTheDocument();
  });

  it("omits the checkpoint row when there is no checkpoint", () => {
    render(<ChatWidget spec={spec({ nextCheckpoint: null })} />);
    expect(screen.queryByTestId("pilot-status-next-checkpoint")).not.toBeInTheDocument();
  });

  it("renders no em dash anywhere in the visible output", () => {
    const { container } = render(<ChatWidget spec={spec()} />);
    expect(container.textContent ?? "").not.toContain("—");
  });
});
