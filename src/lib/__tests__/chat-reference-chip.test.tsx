/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";

const fetchMock = jest.fn();

beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
  Object.defineProperty(window, "localStorage", {
    value: {
      _store: { instinct_token: "t" } as Record<string, string>,
      getItem(this: { _store: Record<string, string> }, k: string) {
        return this._store[k] ?? null;
      },
      setItem() {},
      removeItem() {},
      clear() {},
    },
    writable: true,
  });
});

beforeEach(() => {
  fetchMock.mockReset();
});

describe("<ChatReferenceChip />", () => {
  test("renders topic + participant count when chat loads", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        chat: {
          id: "c1",
          msChatId: "ms-c1",
          topic: "Q2 planning",
          chatType: "group",
          participants: [
            { displayName: "Alice" },
            { displayName: "Bob" },
            { displayName: "Carol" },
          ],
        },
      }),
    });

    const Chip = (await import("@/components/teams/ChatReferenceChip")).default;
    render(<Chip chatId="c1" />);

    await waitFor(() => {
      expect(screen.getByText(/Q2 planning/)).toBeInTheDocument();
    });
    expect(screen.getByText(/3 participants/)).toBeInTheDocument();
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toContain("teams.microsoft.com");
    expect(link.getAttribute("href")).toContain("ms-c1");
  });

  test("renders unavailable on 404", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    const Chip = (await import("@/components/teams/ChatReferenceChip")).default;
    render(<Chip chatId="c-missing" />);
    await waitFor(() => {
      expect(screen.getByText(/unavailable/)).toBeInTheDocument();
    });
  });

  test("renders unavailable on network error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"));
    const Chip = (await import("@/components/teams/ChatReferenceChip")).default;
    render(<Chip chatId="c1" />);
    await waitFor(() => {
      expect(screen.getByText(/unavailable/)).toBeInTheDocument();
    });
  });

  test("falls back to first participant name when topic missing", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        chat: {
          id: "c1",
          msChatId: "ms-c1",
          topic: null,
          chatType: "oneOnOne",
          participants: [{ displayName: "Bob" }],
        },
      }),
    });
    const Chip = (await import("@/components/teams/ChatReferenceChip")).default;
    render(<Chip chatId="c1" />);
    await waitFor(() => {
      expect(screen.getByText(/Bob/)).toBeInTheDocument();
    });
  });
});
