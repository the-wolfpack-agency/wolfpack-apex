/**
 * @jest-environment jsdom
 */
/**
 * EventModal UI tests: fields render, submit wires to POST /api/calendar/events,
 * and the Teams online-meeting toggle is disabled with tooltip.
 */

import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

jest.mock("@/lib/client-auth", () => ({
  jsonHeaders: () => ({ Authorization: "Bearer t", "Content-Type": "application/json" }),
  authHeaders: () => ({ Authorization: "Bearer t" }),
  fetchWithRefresh: jest.fn((url, opts) => fetch(url, opts)), fetchJsonWithRefresh: jest.fn(async (url, opts) => (await fetch(url, opts)).json()) }));

import { EventModal } from "@/components/calendar/EventModal";

const fetchMock = jest.fn();

beforeAll(() => {
  (global as any).fetch = fetchMock;
});

beforeEach(() => {
  fetchMock.mockReset();
});

describe("EventModal", () => {
  it("renders Subject/Start/End/Attendees/Location/Notes fields when open", () => {
    render(<EventModal open={true} onClose={() => {}} />);
    expect(screen.getByLabelText(/^Subject/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Start/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^End/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Attendee email input/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Location/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Notes/i)).toBeInTheDocument();
  });

  it("online-meeting toggle is disabled with tooltip", () => {
    render(<EventModal open={true} onClose={() => {}} />);
    const toggle = screen.getByTestId("online-meeting-toggle") as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    const label = screen.getByTestId("online-meeting-label");
    expect(label.getAttribute("title")).toMatch(/Available after Teams scope is granted/);
  });

  it("POSTs to /api/calendar/events on submit, fires onCreated", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ id: "ev-1", webLink: "http://outlook/ev-1" }),
    });
    const onCreated = jest.fn();
    const onClose = jest.fn();
    render(<EventModal open={true} onClose={onClose} onCreated={onCreated} />);

    fireEvent.change(screen.getByLabelText(/^Subject/i), { target: { value: "Standup" } });
    // Default start/end are already populated (next hour + 2h)
    await act(async () => {
      fireEvent.click(screen.getByTestId("event-submit"));
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/calendar/events");
    const body = JSON.parse(init.body);
    expect(body.subject).toBe("Standup");
    expect(typeof body.start).toBe("string");
    expect(typeof body.end).toBe("string");
    expect(body.isOnlineMeeting).toBe(false);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("ev-1", "http://outlook/ev-1"));
  });

  it("surfaces scope_missing error cleanly", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: "forbidden", code: "scope_missing", scope: "Calendars.ReadWrite" }),
    });
    render(<EventModal open={true} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/^Subject/i), { target: { value: "s" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("event-submit"));
    });
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/Calendars\.ReadWrite/);
    });
  });

  it("rejects when end <= start (submit button disabled)", () => {
    const start = "2026-05-01T10:00";
    render(<EventModal open={true} onClose={() => {}} initialStart={start + ":00Z"} initialEnd={start + ":00Z"} />);
    fireEvent.change(screen.getByLabelText(/^Subject/i), { target: { value: "bad" } });
    // Force end BEFORE start
    fireEvent.change(screen.getByLabelText(/^Start/i), { target: { value: "2026-05-01T12:00" } });
    fireEvent.change(screen.getByLabelText(/^End/i), { target: { value: "2026-05-01T11:00" } });
    expect((screen.getByTestId("event-submit") as HTMLButtonElement).disabled).toBe(true);
  });
});
