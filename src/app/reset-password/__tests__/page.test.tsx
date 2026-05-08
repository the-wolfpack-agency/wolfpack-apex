/**
 * @jest-environment jsdom
 */
/**
 * UI tests for /reset-password.
 *
 * Validates:
 *   - missing token → inline error, submit disabled
 *   - weak password / mismatched confirm → inline error, no fetch
 *   - happy path → POSTs to /api/auth/reset-password + redirects to /login?reset=1
 *   - server 404 → inline "expired" error, no redirect
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockPush = jest.fn();
const mockGetParam = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => ({ get: (k: string) => mockGetParam(k) }),
}));

import ResetPasswordPage from "@/app/reset-password/page";

const realFetch = global.fetch;
beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn() as any;
});
afterAll(() => {
  global.fetch = realFetch;
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

describe("ResetPasswordPage", () => {
  it("missing token: shows error + submit disabled", () => {
    mockGetParam.mockReturnValue(null);
    render(<ResetPasswordPage />);
    expect(screen.getByTestId("reset-password-error").textContent).toMatch(/Missing reset token/i);
    expect(screen.getByTestId("reset-password-submit")).toBeDisabled();
  });

  it("weak password: inline error, no fetch", async () => {
    mockGetParam.mockReturnValue("tok");
    render(<ResetPasswordPage />);
    fireEvent.change(screen.getByTestId("reset-password-input"), { target: { value: "short" } });
    fireEvent.change(screen.getByTestId("reset-password-confirm"), { target: { value: "short" } });
    fireEvent.submit(screen.getByTestId("reset-password-form"));
    await waitFor(() =>
      expect(screen.getByTestId("reset-password-error").textContent).toMatch(/at least 8/i),
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("mismatched confirm: inline error, no fetch", async () => {
    mockGetParam.mockReturnValue("tok");
    render(<ResetPasswordPage />);
    fireEvent.change(screen.getByTestId("reset-password-input"), { target: { value: "longpassword1" } });
    fireEvent.change(screen.getByTestId("reset-password-confirm"), { target: { value: "longpassword2" } });
    fireEvent.submit(screen.getByTestId("reset-password-form"));
    await waitFor(() =>
      expect(screen.getByTestId("reset-password-error").textContent).toMatch(/don't match/i),
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("happy path: POSTs to /api/auth/reset-password, redirects to /login?reset=1", async () => {
    mockGetParam.mockReturnValue("tok");
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    render(<ResetPasswordPage />);
    fireEvent.change(screen.getByTestId("reset-password-input"), { target: { value: "longpassword" } });
    fireEvent.change(screen.getByTestId("reset-password-confirm"), { target: { value: "longpassword" } });
    fireEvent.submit(screen.getByTestId("reset-password-form"));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/login?reset=1"));
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/auth/reset-password",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: "tok", password: "longpassword" }),
      }),
    );
  });

  it("server 404 surfaces 'expired' inline error, no redirect", async () => {
    mockGetParam.mockReturnValue("tok");
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      jsonResponse(404, { error: "Invalid or expired reset link" }),
    );
    render(<ResetPasswordPage />);
    fireEvent.change(screen.getByTestId("reset-password-input"), { target: { value: "longpassword" } });
    fireEvent.change(screen.getByTestId("reset-password-confirm"), { target: { value: "longpassword" } });
    fireEvent.submit(screen.getByTestId("reset-password-form"));

    await waitFor(() =>
      expect(screen.getByTestId("reset-password-error").textContent).toMatch(/expired/i),
    );
    expect(mockPush).not.toHaveBeenCalled();
  });
});
