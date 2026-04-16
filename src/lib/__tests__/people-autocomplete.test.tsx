/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

const fetchMockPA = jest.fn();

beforeAll(() => {
  global.fetch = fetchMockPA as unknown as typeof fetch;
  Object.defineProperty(window, "localStorage", {
    value: {
      _store: { instinct_token: "t" } as Record<string, string>,
      getItem(this: any, k: string) { return this._store[k] ?? null; },
      setItem(this: any, k: string, v: string) { this._store[k] = v; },
      removeItem(this: any, k: string) { delete this._store[k]; },
      clear(this: any) { this._store = {}; },
    },
    writable: true,
  });
});

beforeEach(() => {
  fetchMockPA.mockReset();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("<PeopleAutocomplete />", () => {
  test("debounces fetches (150ms)", async () => {
    fetchMockPA.mockResolvedValue({
      ok: true,
      json: async () => ({ suggestions: [{ personId: "p1", displayName: "Alice", email: "a@x", score: 0.5, source: "" }] }),
    });
    const PeopleAutocomplete = (await import("@/components/people/PeopleAutocomplete")).default;
    render(<PeopleAutocomplete onPick={() => {}} />);

    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.change(input, { target: { value: "al" } });
    fireEvent.change(input, { target: { value: "ali" } });

    // Before debounce fires, no fetch.
    expect(fetchMockPA).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(160);
    });
    // Exactly one fetch for the most recent value.
    await waitFor(() => expect(fetchMockPA).toHaveBeenCalledTimes(1));
    const calledUrl = fetchMockPA.mock.calls[0][0] as string;
    expect(calledUrl).toContain("q=ali");
  });

  test("clicking a suggestion fires onPick", async () => {
    fetchMockPA.mockResolvedValue({
      ok: true,
      json: async () => ({ suggestions: [{ personId: "p1", displayName: "Alice", email: "a@x", score: 0.5, source: "" }] }),
    });
    const onPick = jest.fn();
    const PeopleAutocomplete = (await import("@/components/people/PeopleAutocomplete")).default;
    render(<PeopleAutocomplete onPick={onPick} />);

    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "al" } });
    await act(async () => {
      jest.advanceTimersByTime(160);
    });
    await waitFor(() => screen.getByText("Alice"));
    fireEvent.click(screen.getByText("Alice"));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ personId: "p1" }));
  });

  test("shows 'No matches' when API returns empty", async () => {
    fetchMockPA.mockResolvedValue({
      ok: true,
      json: async () => ({ suggestions: [] }),
    });
    const PeopleAutocomplete = (await import("@/components/people/PeopleAutocomplete")).default;
    render(<PeopleAutocomplete onPick={() => {}} />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "zzz" } });
    await act(async () => {
      jest.advanceTimersByTime(160);
    });
    await waitFor(() => screen.getByText("No matches"));
  });
});
