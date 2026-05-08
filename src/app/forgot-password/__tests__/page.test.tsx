/**
 * @jest-environment jsdom
 */
/**
 * UI tests for /forgot-password.
 *
 * Validates:
 *   - email validation gate (no @ → inline error, no fetch)
 *   - happy path → POSTs to /api/auth/forgot-password and shows success
 *   - dev_link surface when email is not delivered
 *   - 429 rate-limit surfaces inline as a friendly error
 *   - cancel link to /login is rendered
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import ForgotPasswordPage from "@/app/forgot-password/page";

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

describe("ForgotPasswordPage", () => {
  it("renders form by default", () => {
    render(<ForgotPasswordPage />);
    expect(screen.getByTestId("forgot-password-form")).toBeInTheDocument();
    expect(screen.getByTestId("forgot-password-email")).toBeInTheDocument();
    expect(screen.getByTestId("forgot-password-cancel")).toHaveAttribute("href", "/login");
  });

  it("invalid email: inline error, no fetch", async () => {
    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByTestId("forgot-password-email"), { target: { value: "no-at-sign" } });
    fireEvent.submit(screen.getByTestId("forgot-password-form"));
    await waitFor(() =>
      expect(screen.getByTestId("forgot-password-error").textContent).toMatch(/valid email/i),
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("happy path with delivery: shows success copy, no dev_link", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByTestId("forgot-password-email"), {
      target: { value: "max@thewolfpack.agency" },
    });
    fireEvent.submit(screen.getByTestId("forgot-password-form"));

    await waitFor(() => expect(screen.getByTestId("forgot-password-success")).toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/auth/forgot-password",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "max@thewolfpack.agency" }),
      }),
    );
    expect(screen.queryByTestId("forgot-password-dev-link")).not.toBeInTheDocument();
  });

  it("dev_link in response surfaces in the success state", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        dev_link: "https://wolfpack-instinct.vercel.app/reset-password?token=tok",
      }),
    );
    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByTestId("forgot-password-email"), {
      target: { value: "max@thewolfpack.agency" },
    });
    fireEvent.submit(screen.getByTestId("forgot-password-form"));

    await waitFor(() => expect(screen.getByTestId("forgot-password-dev-link")).toBeInTheDocument());
    expect(screen.getByTestId("forgot-password-dev-link").textContent).toContain(
      "/reset-password?token=tok",
    );
  });

  it("429 rate-limit surfaces inline error", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      jsonResponse(429, { error: "Too many attempts. Try again later." }),
    );
    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByTestId("forgot-password-email"), {
      target: { value: "max@thewolfpack.agency" },
    });
    fireEvent.submit(screen.getByTestId("forgot-password-form"));

    await waitFor(() =>
      expect(screen.getByTestId("forgot-password-error").textContent).toMatch(/too many/i),
    );
    expect(screen.queryByTestId("forgot-password-success")).not.toBeInTheDocument();
  });
});
