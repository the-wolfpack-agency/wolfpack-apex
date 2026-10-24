/** @jest-environment jsdom */
import "@testing-library/jest-dom";

/**
 * /mfa: where the dashboard layout sends an admin the MFA gate is holding.
 * Each server answer renders its own state (enroll, challenge, unavailable,
 * error), an unauthenticated visitor is sent to /login, nothing-required goes
 * straight to `next`, and the challenge form validates, reports a wrong code,
 * and continues on success. Navigation is observed via a stubbed location.
 */
const mockFetchWithRefresh = jest.fn();
let mockToken: string | null = "t";
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
  getInstinctToken: () => mockToken,
}));

const assigned: string[] = [];
jest.mock("@/lib/auth/mfa-client", () => ({
  ...jest.requireActual("@/lib/auth/mfa-client"),
  navigateTo: (href: string) => assigned.push(href),
}));

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import MfaPage from "@/app/mfa/page";

function mkRes(body: unknown, ok = true, status = 200): unknown {
  return { ok, status, json: async () => body };
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockToken = "t";
  assigned.length = 0;
  window.history.pushState({}, "", "/mfa?next=%2Fadmin%2Fteam");
});

const status = (required: unknown, extra: Record<string, unknown> = {}) =>
  mkRes({ enrolled: false, confirmed: false, recoveryCodesRemaining: 0, confirmedAt: null, enforced: true, required, ...extra });

describe("/mfa page", () => {
  it("sends an unauthenticated visitor to /login with a return path", async () => {
    mockToken = null;
    render(<MfaPage />);
    await waitFor(() => expect(assigned[0]).toMatch(/^\/login\?next=%2Fmfa/));
    expect(mockFetchWithRefresh).not.toHaveBeenCalled();
  });

  it("shows enrollment when the gate requires it", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(status("enroll")).mockResolvedValueOnce(status("enroll"));
    render(<MfaPage />);
    expect(await screen.findByTestId("mfa-page-enroll")).toBeInTheDocument();
    expect(screen.getByTestId("mfa-page")).toHaveAttribute("data-view", "enroll");
    expect(await screen.findByTestId("mfa-settings-card")).toBeInTheDocument();
  });

  it("goes straight to next when nothing is required", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(status(null));
    render(<MfaPage />);
    await waitFor(() => expect(assigned).toEqual(["/admin/team"]));
  });

  it("shows a clear unavailable state, and an error state on a failed status read", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(status("unavailable"));
    const { unmount } = render(<MfaPage />);
    expect(await screen.findByTestId("mfa-page-unavailable")).toBeInTheDocument();
    unmount();
    mockFetchWithRefresh.mockResolvedValueOnce(mkRes({}, false, 500));
    render(<MfaPage />);
    expect(await screen.findByTestId("mfa-page-error")).toHaveTextContent("HTTP 500");
  });

  it("challenge: validates, reports a wrong code, continues on the right one", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(status("challenge", { confirmed: true, enrolled: true }));
    render(<MfaPage />);
    const input = await screen.findByTestId("mfa-challenge-input");

    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.click(screen.getByTestId("mfa-challenge-submit"));
    expect(await screen.findByTestId("mfa-page-error")).toHaveTextContent(/6-digit/);
    expect(mockFetchWithRefresh).toHaveBeenCalledTimes(1);

    mockFetchWithRefresh.mockResolvedValueOnce(mkRes({ ok: false, error: "bad_code" }, false, 400));
    fireEvent.change(input, { target: { value: "000000" } });
    fireEvent.click(screen.getByTestId("mfa-challenge-submit"));
    expect(await screen.findByText(/didn't match/)).toBeInTheDocument();

    mockFetchWithRefresh.mockResolvedValueOnce(mkRes({}, false, 429));
    fireEvent.change(input, { target: { value: "111111" } });
    fireEvent.click(screen.getByTestId("mfa-challenge-submit"));
    expect(await screen.findByText(/Too many wrong codes/)).toBeInTheDocument();

    mockFetchWithRefresh.mockResolvedValueOnce(mkRes({ ok: true, usedRecoveryCode: false, recoveryCodesRemaining: 10 }));
    fireEvent.change(input, { target: { value: "123456" } });
    fireEvent.click(screen.getByTestId("mfa-challenge-submit"));
    await waitFor(() => expect(assigned).toEqual(["/admin/team"]));
    const [path, init] = mockFetchWithRefresh.mock.calls[3] as [string, { body: string; method: string }];
    expect(path).toBe("/api/auth/mfa/challenge");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ code: "123456" });
  });

  it("accepts a recovery code in the challenge", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(status("challenge"));
    render(<MfaPage />);
    mockFetchWithRefresh.mockResolvedValueOnce(mkRes({ ok: true, usedRecoveryCode: true, recoveryCodesRemaining: 9 }));
    fireEvent.change(await screen.findByTestId("mfa-challenge-input"), { target: { value: "a1b2c-3d4e5" } });
    fireEvent.click(screen.getByTestId("mfa-challenge-submit"));
    await waitFor(() => expect(assigned).toEqual(["/admin/team"]));
  });
});
