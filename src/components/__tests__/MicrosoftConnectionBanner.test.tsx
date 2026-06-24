/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * MicrosoftConnectionBanner - makes a revoked / expired Microsoft 365
 * token loud instead of silent (before this, a disconnected token just
 * blanked the calendar/mail/tasks widgets with no signal).
 *
 * Coverage:
 *   - renders the warning banner + reconnect button when status returns
 *     microsoft.connected = false
 *   - renders nothing when connected = true
 *   - renders nothing while loading (status promise not yet resolved)
 *   - renders nothing on a status fetch error
 *   - Reconnect calls /api/auth/microsoft-start and navigates to authUrl
 *   - Reconnect surfaces an inline error (does not crash) on failure
 *   - Dismiss hides the banner for the session
 */

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
}));

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import MicrosoftConnectionBanner from "@/components/MicrosoftConnectionBanner";

/** Mock /api/integrations/status, falling through to {} for any other URL. */
function mockStatus(
  body: unknown,
  { ok = true }: { ok?: boolean } = {},
) {
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (typeof url === "string" && url === "/api/integrations/status") {
      return Promise.resolve({ ok, json: async () => body });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

describe("MicrosoftConnectionBanner", () => {
  it("renders the warning banner + reconnect button when microsoft.connected is false", async () => {
    mockStatus({ microsoft: { connected: false }, quickbooks: { connected: true } });
    render(<MicrosoftConnectionBanner />);
    await waitFor(() =>
      expect(screen.getByTestId("ms-disconnected-banner")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("ms-reconnect-btn")).toBeInTheDocument();
    expect(screen.getByTestId("ms-banner-dismiss")).toBeInTheDocument();
    // Clear, user-facing message - calendar/mail/tasks reason.
    expect(screen.getByTestId("ms-disconnected-banner")).toHaveTextContent(
      /Microsoft 365 is disconnected/i,
    );
    expect(screen.getByTestId("ms-disconnected-banner")).toHaveTextContent(
      /calendar, mail, and tasks/i,
    );
  });

  it("renders nothing when microsoft.connected is true", async () => {
    mockStatus({ microsoft: { connected: true } });
    const { container } = render(<MicrosoftConnectionBanner />);
    // Let the status promise resolve.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("ms-disconnected-banner")).toBeNull();
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing while loading (status not yet resolved)", () => {
    // A never-resolving promise keeps us in the loading state.
    mockFetchWithRefresh.mockImplementation(() => new Promise(() => {}));
    const { container } = render(<MicrosoftConnectionBanner />);
    expect(screen.queryByTestId("ms-disconnected-banner")).toBeNull();
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing on a status fetch error (graceful, no crash)", async () => {
    mockFetchWithRefresh.mockImplementation((url: string) => {
      if (typeof url === "string" && url === "/api/integrations/status") {
        return Promise.reject(new Error("network down"));
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    const { container } = render(<MicrosoftConnectionBanner />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("ms-disconnected-banner")).toBeNull();
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing on a non-ok status response", async () => {
    mockStatus({ microsoft: { connected: false } }, { ok: false });
    const { container } = render(<MicrosoftConnectionBanner />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("ms-disconnected-banner")).toBeNull();
    expect(container.innerHTML).toBe("");
  });

  it("Reconnect calls /api/auth/microsoft-start, reads authUrl, and navigates (no error)", async () => {
    const authUrl = "https://login.microsoftonline.com/authorize?x=1";
    const jsonSpy = jest.fn(async () => ({ authUrl }));
    mockFetchWithRefresh.mockImplementation((url: string) => {
      if (typeof url === "string" && url === "/api/integrations/status") {
        return Promise.resolve({ ok: true, json: async () => ({ microsoft: { connected: false } }) });
      }
      if (typeof url === "string" && url === "/api/auth/microsoft-start") {
        return Promise.resolve({ ok: true, json: jsonSpy });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    // JSDOM's window.location is non-configurable and a real href assignment
    // triggers a "navigation not implemented" log (it does NOT throw). We
    // assert the full reconnect path runs: start endpoint called, authUrl
    // read, and NO inline error surfaced (proving navigation, not the catch,
    // was taken). The literal href= write is the one line JSDOM can't observe.
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    render(<MicrosoftConnectionBanner />);
    await waitFor(() =>
      expect(screen.getByTestId("ms-reconnect-btn")).toBeInTheDocument(),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("ms-reconnect-btn"));
    });

    await waitFor(() =>
      expect(
        mockFetchWithRefresh.mock.calls.some((c) => c[0] === "/api/auth/microsoft-start"),
      ).toBe(true),
    );
    await waitFor(() => expect(jsonSpy).toHaveBeenCalled());
    // Navigation path taken, not the error path.
    expect(screen.queryByTestId("ms-reconnect-error")).toBeNull();

    errSpy.mockRestore();
  });

  it("Reconnect surfaces an inline error and does not crash on failure", async () => {
    mockFetchWithRefresh.mockImplementation((url: string) => {
      if (typeof url === "string" && url === "/api/integrations/status") {
        return Promise.resolve({ ok: true, json: async () => ({ microsoft: { connected: false } }) });
      }
      if (typeof url === "string" && url === "/api/auth/microsoft-start") {
        return Promise.reject(new Error("start failed"));
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<MicrosoftConnectionBanner />);
    await waitFor(() =>
      expect(screen.getByTestId("ms-reconnect-btn")).toBeInTheDocument(),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("ms-reconnect-btn"));
    });

    await waitFor(() =>
      expect(screen.getByTestId("ms-reconnect-error")).toBeInTheDocument(),
    );
    // Banner is still present - no crash.
    expect(screen.getByTestId("ms-disconnected-banner")).toBeInTheDocument();
  });

  it("Dismiss hides the banner for the session", async () => {
    mockStatus({ microsoft: { connected: false } });
    render(<MicrosoftConnectionBanner />);
    await waitFor(() =>
      expect(screen.getByTestId("ms-disconnected-banner")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("ms-banner-dismiss"));
    expect(screen.queryByTestId("ms-disconnected-banner")).toBeNull();
  });
});
