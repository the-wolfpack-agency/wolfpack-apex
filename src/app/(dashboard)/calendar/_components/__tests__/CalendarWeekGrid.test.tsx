/** @jest-environment jsdom */
 
import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";

const mockEmit = jest.fn();
jest.mock("@/lib/insights/emit", () => ({
  emitInsight: (e: unknown) => mockEmit(e),
}));

import CalendarWeekGrid, {
  positionEventInDay,
  WeekGridEvent,
} from "@/app/(dashboard)/calendar/_components/CalendarWeekGrid";

beforeEach(() => mockEmit.mockReset());

// Anchor fixed inside Apr 23 2026 (a Thursday). Sunday-anchored week
// → 2026-04-19 .. 2026-04-25.
const ANCHOR = "2026-04-23";
const NOW = new Date("2026-04-23T10:00:00");

function ev(id: string, startIso: string, endIso: string, subject = id): WeekGridEvent {
  return { id, subject, start: startIso, end: endIso };
}

describe("positionEventInDay (pure helper)", () => {
  test("computes top + height in px from start/end relative to dayStartHour", () => {
    // 9:00 → 10:30, dayStart 8 → 60min from start, 90min duration
    const r = positionEventInDay(
      ev("x", "2026-04-23T09:00:00", "2026-04-23T10:30:00"),
      8,
      19,
    );
    // 60 / 60 * 48 = 48; 90 / 60 * 48 = 72
    expect(r.topPx).toBe(48);
    expect(r.heightPx).toBe(72);
  });

  test("clips early-morning events to the visible day window", () => {
    // 6am → 9am with dayStart 8 → topPx clamped to 0, height = 60min
    const r = positionEventInDay(
      ev("x", "2026-04-23T06:00:00", "2026-04-23T09:00:00"),
      8,
      19,
    );
    expect(r.topPx).toBe(0);
    expect(r.heightPx).toBe(48);
  });

  test("clips late-evening events to the visible day window", () => {
    // 6pm → 9pm with dayEnd 19 → end clamped, height = 60min
    const r = positionEventInDay(
      ev("x", "2026-04-23T18:00:00", "2026-04-23T21:00:00"),
      8,
      19,
    );
    expect(r.heightPx).toBe(48);
  });

  test("enforces a minimum height so very short events stay clickable", () => {
    const r = positionEventInDay(
      ev("x", "2026-04-23T09:00:00", "2026-04-23T09:05:00"),
      8,
      19,
    );
    expect(r.heightPx).toBeGreaterThanOrEqual(18);
  });
});

describe("<CalendarWeekGrid />", () => {
  test("renders all 7 day-of-week headers with the correct dates for the anchor's week", () => {
    render(
      <CalendarWeekGrid
        events={[]}
        anchorIso={ANCHOR}
        onEventClick={() => {}}
        _now={() => NOW}
      />,
    );
    // Sunday-anchored: 19, 20, 21, 22, 23, 24, 25
    expect(screen.getByTestId("calendar-week-day-header-0")).toHaveAttribute("data-iso", "2026-04-19");
    expect(screen.getByTestId("calendar-week-day-header-4")).toHaveAttribute("data-iso", "2026-04-23");
    expect(screen.getByTestId("calendar-week-day-header-6")).toHaveAttribute("data-iso", "2026-04-25");
  });

  test("places a timed event in the correct day column with positioned top/height", () => {
    render(
      <CalendarWeekGrid
        events={[
          ev("e-thu-10", "2026-04-23T10:00:00", "2026-04-23T11:00:00", "Greenfield sync"),
        ]}
        anchorIso={ANCHOR}
        onEventClick={() => {}}
        _now={() => NOW}
      />,
    );
    // Thursday is day index 4.
    const col = screen.getByTestId("calendar-week-col-4");
    const card = within(col).getByTestId("calendar-week-event-e-thu-10");
    expect(card).toHaveTextContent(/Greenfield sync/);
    // 10:00 with dayStart 8 → top 96px, 60min → height 48px
    expect((card as HTMLElement).style.top).toBe("96px");
    expect((card as HTMLElement).style.height).toBe("48px");
  });

  test("renders all-day events in the all-day lane, not the time grid", () => {
    render(
      <CalendarWeekGrid
        events={[
          ev("e-allday", "2026-04-23T00:00:00", "2026-04-24T00:00:00", "Conference day"),
        ]}
        anchorIso={ANCHOR}
        onEventClick={() => {}}
        _now={() => NOW}
      />,
    );
    expect(screen.getByTestId("calendar-week-allday-lane")).toBeInTheDocument();
    const col4 = screen.getByTestId("calendar-week-allday-col-4");
    expect(within(col4).getByTestId("calendar-week-event-e-allday")).toBeInTheDocument();
  });

  test("clicking a timed event fires onEventClick AND emits insight payload", () => {
    const onEventClick = jest.fn();
    render(
      <CalendarWeekGrid
        events={[ev("e-thu-10", "2026-04-23T10:00:00", "2026-04-23T11:00:00", "S")]}
        anchorIso={ANCHOR}
        onEventClick={onEventClick}
        _now={() => NOW}
      />,
    );
    fireEvent.click(screen.getByTestId("calendar-week-event-e-thu-10"));
    expect(onEventClick).toHaveBeenCalledWith("e-thu-10");
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "calendar",
        action: "grid_event_clicked",
        payload: expect.objectContaining({ event_id: "e-thu-10", slot: "timed" }),
      }),
    );
  });

  test("clicking an all-day event emits a slot=all_day insight", () => {
    const onEventClick = jest.fn();
    render(
      <CalendarWeekGrid
        events={[ev("e-allday", "2026-04-23T00:00:00", "2026-04-24T00:00:00", "x")]}
        anchorIso={ANCHOR}
        onEventClick={onEventClick}
        _now={() => NOW}
      />,
    );
    fireEvent.click(screen.getByTestId("calendar-week-event-e-allday"));
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "calendar",
        action: "grid_event_clicked",
        payload: expect.objectContaining({ slot: "all_day" }),
      }),
    );
  });

  test("Prev / Next / Today buttons fire callbacks AND emit grid_navigated insights", () => {
    const onPrev = jest.fn();
    const onNext = jest.fn();
    const onToday = jest.fn();
    render(
      <CalendarWeekGrid
        events={[]}
        anchorIso={ANCHOR}
        onEventClick={() => {}}
        onPrevWeek={onPrev}
        onNextWeek={onNext}
        onToday={onToday}
        _now={() => NOW}
      />,
    );
    fireEvent.click(screen.getByTestId("calendar-week-prev"));
    fireEvent.click(screen.getByTestId("calendar-week-next"));
    fireEvent.click(screen.getByTestId("calendar-week-today"));
    expect(onPrev).toHaveBeenCalled();
    expect(onNext).toHaveBeenCalled();
    expect(onToday).toHaveBeenCalled();
    const directions = mockEmit.mock.calls
      .map((c) => c[0])
      .filter((e: any) => e.action === "grid_navigated")
      .map((e: any) => e.payload.direction);
    expect(directions).toEqual(["prev", "next", "today"]);
  });

  test('renders the "now" line on today\'s column when current time is inside the visible window', () => {
    render(
      <CalendarWeekGrid
        events={[]}
        anchorIso={ANCHOR}
        onEventClick={() => {}}
        _now={() => NOW}
      />,
    );
    const line = screen.getByTestId("calendar-week-now-line");
    // 10am with dayStart 8 → top 96px
    expect((line as HTMLElement).style.top).toBe("96px");
    // Lives inside Thursday's column (day idx 4).
    const col4 = screen.getByTestId("calendar-week-col-4");
    expect(col4).toContainElement(line);
  });

  test("does NOT render now line when 'now' falls outside the dayStart..dayEnd window", () => {
    render(
      <CalendarWeekGrid
        events={[]}
        anchorIso={ANCHOR}
        onEventClick={() => {}}
        _now={() => new Date("2026-04-23T05:00:00")}
      />,
    );
    expect(screen.queryByTestId("calendar-week-now-line")).toBeNull();
  });

  test("ignores events outside the visible week without crashing", () => {
    render(
      <CalendarWeekGrid
        events={[
          ev("inside", "2026-04-23T09:00:00", "2026-04-23T10:00:00", "in"),
          ev("outside", "2026-05-15T09:00:00", "2026-05-15T10:00:00", "out"),
        ]}
        anchorIso={ANCHOR}
        onEventClick={() => {}}
        _now={() => NOW}
      />,
    );
    expect(screen.getByTestId("calendar-week-event-inside")).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-week-event-outside")).toBeNull();
  });
});
