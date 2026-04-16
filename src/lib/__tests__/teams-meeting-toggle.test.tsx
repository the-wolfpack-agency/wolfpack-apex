/**
 * @jest-environment jsdom
 */
/**
 * TeamsMeetingToggle UI tests — capability probe gating.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export {};

import "@testing-library/jest-dom";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import TeamsMeetingToggle from "@/components/calendar/TeamsMeetingToggle";

const realFetchTMT = global.fetch;
const fetchMockTMT = jest.fn();

beforeEach(() => {
  (global as any).fetch = fetchMockTMT;
  fetchMockTMT.mockReset();
});

afterAll(() => {
  (global as any).fetch = realFetchTMT;
});

describe("TeamsMeetingToggle", () => {
  it("uses capabilityOverride when provided (enabled)", () => {
    const onChange = jest.fn();
    render(
      <TeamsMeetingToggle
        checked={false}
        onChange={onChange}
        capabilityOverride={true}
      />,
    );
    const input = screen.getByTestId("online-meeting-toggle") as HTMLInputElement;
    expect(input.disabled).toBe(false);
    fireEvent.click(input);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("is disabled when capability probe returns false", async () => {
    fetchMockTMT.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ onlineMeetings: false }),
    });
    render(<TeamsMeetingToggle checked={false} onChange={() => {}} />);
    await waitFor(() => {
      const input = screen.getByTestId("online-meeting-toggle") as HTMLInputElement;
      expect(input.disabled).toBe(true);
    });
  });

  it("is enabled when capability probe returns true", async () => {
    fetchMockTMT.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ onlineMeetings: true }),
    });
    render(<TeamsMeetingToggle checked={false} onChange={() => {}} />);
    await waitFor(() => {
      const input = screen.getByTestId("online-meeting-toggle") as HTMLInputElement;
      expect(input.disabled).toBe(false);
    });
  });

  it("falls back to disabled when probe errors", async () => {
    fetchMockTMT.mockRejectedValueOnce(new Error("network"));
    render(<TeamsMeetingToggle checked={false} onChange={() => {}} />);
    await waitFor(() => {
      const input = screen.getByTestId("online-meeting-toggle") as HTMLInputElement;
      expect(input.disabled).toBe(true);
    });
    // Shows the tooltip text for users
    expect(screen.getByText(/Available after Teams scope/)).toBeTruthy();
  });

  it("forwards authorization header from getAuthHeader", async () => {
    fetchMockTMT.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ onlineMeetings: true }),
    });
    render(
      <TeamsMeetingToggle
        checked={false}
        onChange={() => {}}
        getAuthHeader={() => "Bearer custom"}
      />,
    );
    await waitFor(() => expect(fetchMockTMT).toHaveBeenCalled());
    const [, init] = fetchMockTMT.mock.calls[0];
    const headers = new Headers(init?.headers ?? {});
    expect(headers.get("authorization")).toBe("Bearer custom");
  });
});
