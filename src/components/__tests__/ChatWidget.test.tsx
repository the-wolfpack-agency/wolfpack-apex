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

describe("ChatWidget", () => {
  test("renders CalendarWidget for kind=calendar", () => {
    render(<ChatWidget spec={calendarSpec} />);
    expect(screen.getByTestId("calendar-widget")).toBeInTheDocument();
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
