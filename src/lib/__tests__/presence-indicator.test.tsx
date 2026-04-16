/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";

const fetchMockPI = jest.fn();

beforeAll(() => {
  global.fetch = fetchMockPI as unknown as typeof fetch;
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

beforeEach(() => fetchMockPI.mockReset());

describe("<PresenceIndicator />", () => {
  test("renders dot + label when presence available", async () => {
    fetchMockPI.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        presence: {
          availability: "Busy",
          activity: "InACall",
          statusMessage: null,
          fetchedAt: new Date().toISOString(),
        },
      }),
    });
    const PresenceIndicator = (await import("@/components/presence/PresenceIndicator")).default;
    render(<PresenceIndicator />);
    await waitFor(() => {
      const wrapper = screen.getByLabelText(/Presence:/);
      expect(wrapper).toHaveAttribute("data-availability", "Busy");
    });
  });

  test("renders unavailable when presence is null", async () => {
    fetchMockPI.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ presence: null }),
    });
    const PresenceIndicator = (await import("@/components/presence/PresenceIndicator")).default;
    render(<PresenceIndicator />);
    await waitFor(() => {
      expect(screen.getByLabelText("Presence unavailable")).toBeInTheDocument();
    });
  });

  test("swallows fetch errors", async () => {
    fetchMockPI.mockRejectedValueOnce(new Error("network"));
    const PresenceIndicator = (await import("@/components/presence/PresenceIndicator")).default;
    const { container } = render(<PresenceIndicator />);
    // Component should not throw; either renders nothing (not loaded) or
    // unavailable after the error resolves.
    await waitFor(() => {
      // At least one of the two branches should be satisfied.
      const unavailable = container.querySelector('[aria-label="Presence unavailable"]');
      expect(unavailable !== null || container.innerHTML === "").toBeTruthy();
    });
  });
});
