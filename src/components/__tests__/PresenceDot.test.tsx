/** @jest-environment jsdom */
 
import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  authHeaders: () => ({ Authorization: "Bearer x" }),
  jsonHeaders: () => ({ "Content-Type": "application/json", Authorization: "Bearer x" }),
}));

import { render, screen, waitFor, act } from "@testing-library/react";
import PresenceDot, {
  colorForAvailability,
  __resetPresenceDotForTests,
} from "@/components/PresenceDot";

jest.useFakeTimers();

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  __resetPresenceDotForTests();
});

afterEach(() => {
  jest.clearAllTimers();
});

describe("colorForAvailability", () => {
  test("Available → green", () => {
    expect(colorForAvailability("Available")).toBe("#22c55e");
    expect(colorForAvailability("AvailableIdle")).toBe("#22c55e");
  });
  test("Busy/DoNotDisturb → red", () => {
    expect(colorForAvailability("Busy")).toBe("#ef4444");
    expect(colorForAvailability("BusyIdle")).toBe("#ef4444");
    expect(colorForAvailability("DoNotDisturb")).toBe("#ef4444");
  });
  test("Away/BeRightBack → yellow", () => {
    expect(colorForAvailability("Away")).toBe("#f59e0b");
    expect(colorForAvailability("BeRightBack")).toBe("#f59e0b");
  });
  test("Offline/PresenceUnknown/unknown → gray", () => {
    expect(colorForAvailability("Offline")).toBe("#9ca3af");
    expect(colorForAvailability("PresenceUnknown")).toBe("#9ca3af");
    expect(colorForAvailability("SomethingElse")).toBe("#9ca3af");
  });
});

describe("PresenceDot", () => {
  test("renders green dot for Available after fetch resolves (status 200)", async () => {
    mockFetchWithRefresh.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        presences: [{ userId: "u1", availability: "Available" }],
      }),
    });

    render(<PresenceDot userId="u1" />);
    // Advance past the 300ms batch window.
    await act(async () => {
      jest.advanceTimersByTime(350);
    });

    await waitFor(() => {
      expect(screen.getByTestId("presence-dot")).toBeInTheDocument();
    });
    const dot = screen.getByTestId("presence-dot");
    expect(dot).toHaveAttribute("data-availability", "Available");
    expect(dot.getAttribute("style") || "").toContain("rgb(34, 197, 94)");
  });

  test("batches multiple dots mounted within 300ms into a single POST", async () => {
    mockFetchWithRefresh.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        presences: [
          { userId: "a", availability: "Available" },
          { userId: "b", availability: "Busy" },
          { userId: "c", availability: "Away" },
        ],
      }),
    });

    render(
      <>
        <PresenceDot userId="a" />
        <PresenceDot userId="b" />
        <PresenceDot userId="c" />
      </>,
    );

    await act(async () => {
      jest.advanceTimersByTime(350);
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("presence-dot")).toHaveLength(3);
    });

    const presenceCalls = mockFetchWithRefresh.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0] === "/api/ms/presence",
    );
    expect(presenceCalls).toHaveLength(1);
    const body = JSON.parse(presenceCalls[0][1].body);
    expect(new Set(body.userIds)).toEqual(new Set(["a", "b", "c"]));

    const dots = screen.getAllByTestId("presence-dot");
    const avail = dots.map((d) => d.getAttribute("data-availability"));
    expect(new Set(avail)).toEqual(new Set(["Available", "Busy", "Away"]));
  });

  test("renders no dot on scope_missing response", async () => {
    mockFetchWithRefresh.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ scope_missing: true }),
    });

    const { container } = render(<PresenceDot userId="u1" />);
    await act(async () => {
      jest.advanceTimersByTime(350);
    });

    await waitFor(() => {
      expect(mockFetchWithRefresh).toHaveBeenCalled();
    });
    expect(container.querySelector("[data-testid='presence-dot']")).toBeNull();
  });

  test("renders no dot on 401", async () => {
    mockFetchWithRefresh.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    });

    const { container } = render(<PresenceDot userId="u1" />);
    await act(async () => {
      jest.advanceTimersByTime(350);
    });
    await waitFor(() => {
      expect(mockFetchWithRefresh).toHaveBeenCalled();
    });
    expect(container.querySelector("[data-testid='presence-dot']")).toBeNull();
  });

  test("dedupes: remounting with a cached userId does not re-POST", async () => {
    mockFetchWithRefresh.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ presences: [{ userId: "u1", availability: "Available" }] }),
    });

    const { unmount } = render(<PresenceDot userId="u1" />);
    await act(async () => {
      jest.advanceTimersByTime(350);
    });
    await waitFor(() => {
      expect(screen.getByTestId("presence-dot")).toBeInTheDocument();
    });
    unmount();

    const before = mockFetchWithRefresh.mock.calls.length;
    render(<PresenceDot userId="u1" />);
    await act(async () => {
      jest.advanceTimersByTime(350);
    });
    expect(mockFetchWithRefresh.mock.calls.length).toBe(before);
  });
});
