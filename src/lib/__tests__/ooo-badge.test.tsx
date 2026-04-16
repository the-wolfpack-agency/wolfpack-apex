/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";

const fetchMockOOO = jest.fn();

beforeAll(() => {
  global.fetch = fetchMockOOO as unknown as typeof fetch;
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

beforeEach(() => fetchMockOOO.mockReset());

describe("<OOOBadge />", () => {
  test("renders when inside active window", async () => {
    const now = Date.now();
    fetchMockOOO.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ooo: {
          isEnabled: true,
          scope: "all",
          startAt: new Date(now - 1000).toISOString(),
          endAt: new Date(now + 60_000).toISOString(),
        },
      }),
    });
    const OOOBadge = (await import("@/components/presence/OOOBadge")).default;
    render(<OOOBadge />);
    await waitFor(() => {
      expect(screen.getByTestId("ooo-badge")).toBeInTheDocument();
    });
  });

  test("hides when outside window", async () => {
    const now = Date.now();
    fetchMockOOO.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ooo: {
          isEnabled: true,
          scope: "all",
          startAt: new Date(now + 60_000).toISOString(),
          endAt: new Date(now + 120_000).toISOString(),
        },
      }),
    });
    const OOOBadge = (await import("@/components/presence/OOOBadge")).default;
    const { container } = render(<OOOBadge />);
    await waitFor(() => {
      // Explicitly ensure fetch resolved so loaded=true has been set.
      expect(fetchMockOOO).toHaveBeenCalled();
    });
    expect(container.querySelector('[data-testid="ooo-badge"]')).toBeNull();
  });

  test("hides when is_enabled=false", async () => {
    fetchMockOOO.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ooo: { isEnabled: false, scope: "none", startAt: null, endAt: null } }),
    });
    const OOOBadge = (await import("@/components/presence/OOOBadge")).default;
    const { container } = render(<OOOBadge />);
    await waitFor(() => {
      expect(fetchMockOOO).toHaveBeenCalled();
    });
    expect(container.querySelector('[data-testid="ooo-badge"]')).toBeNull();
  });

  test("alwaysEnabled (no window) is treated as active", async () => {
    fetchMockOOO.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ooo: { isEnabled: true, scope: "external", startAt: null, endAt: null },
      }),
    });
    const OOOBadge = (await import("@/components/presence/OOOBadge")).default;
    render(<OOOBadge />);
    await waitFor(() => {
      expect(screen.getByTestId("ooo-badge")).toBeInTheDocument();
    });
  });

  test("fetches cache-only endpoint when instinctUserId provided", async () => {
    fetchMockOOO.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ooo: null }),
    });
    const OOOBadge = (await import("@/components/presence/OOOBadge")).default;
    render(<OOOBadge instinctUserId="u2" />);
    await waitFor(() => {
      expect(fetchMockOOO).toHaveBeenCalled();
    });
    const [url] = fetchMockOOO.mock.calls[0];
    expect(String(url)).toContain("/api/directory/users/u2/ooo");
  });
});
