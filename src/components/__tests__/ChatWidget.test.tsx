/**
 * @jest-environment jsdom
 *
 * ChatWidget — discriminator dispatcher.
 * - Renders CalendarWidget for `kind: "calendar"`
 * - Renders null for unknown kinds (forward-compat — no crash)
 * - Renders null for malformed specs
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { ChatWidget } from "@/components/ChatWidget";
import type { WidgetSpec } from "@/lib/assistant/widgets/types";

const calendarSpec: WidgetSpec = {
  kind: "calendar",
  month: "2026-05-01T00:00:00.000Z",
  rangeStart: "2026-05-01T00:00:00.000Z",
  rangeEnd: "2026-06-01T00:00:00.000Z",
  events: [],
};

const emailSpec: WidgetSpec = {
  kind: "email_thread",
  title: "Recent inbox",
  messages: [],
};

const tasksSpec: WidgetSpec = {
  kind: "task_list",
  title: "Open tasks",
  tasks: [],
};

const goodMorningSpec: WidgetSpec = {
  kind: "good_morning",
  greeting: "Good morning",
  summary: "Clear today.",
  schedule: { eventCount: 0, events: [] },
  actionItems: [],
  connected: true,
};

describe("ChatWidget", () => {
  test("renders CalendarWidget for kind=calendar", () => {
    render(<ChatWidget spec={calendarSpec} />);
    expect(screen.getByTestId("calendar-widget")).toBeInTheDocument();
  });

  test("renders EmailThreadWidget for kind=email_thread", () => {
    render(<ChatWidget spec={emailSpec} />);
    expect(screen.getByTestId("email-thread-widget")).toBeInTheDocument();
  });

  test("renders TaskListWidget for kind=task_list", () => {
    render(<ChatWidget spec={tasksSpec} />);
    expect(screen.getByTestId("task-list-widget")).toBeInTheDocument();
  });

  test("renders GoodMorningWidget for kind=good_morning", () => {
    render(<ChatWidget spec={goodMorningSpec} />);
    expect(screen.getByTestId("good-morning-widget")).toBeInTheDocument();
  });

  test("renders nothing for unknown kind (forward-compat)", () => {
    const { container } = render(
      <ChatWidget spec={{ kind: "unknown-future-widget" } as unknown as WidgetSpec} />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("renders nothing for null/undefined spec", () => {
    const { container } = render(
      <ChatWidget spec={null as unknown as WidgetSpec} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
