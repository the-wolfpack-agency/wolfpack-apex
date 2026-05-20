/**
 * @jest-environment jsdom
 */
/**
 * UI tests for /accept-invite page.
 *
 * Covers:
 *   - Missing token → shows error, submit disabled
 *   - Submit with weak password → inline error, no fetch
 *   - Submit with mismatched confirm → inline error
 *   - Happy path → fetch /api/team/accept then router.push("/login?invited=1")
 *   - Server error → inline error, no redirect
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

import AcceptInvitePage from "@/app/accept-invite/page";

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

describe("AcceptInvitePage", () => {
  it("missing token: shows error, blocks submit", () => {
    mockGetParam.mockReturnValue(null);
    render(<AcceptInvitePage />);
    expect(screen.getByTestId("accept-invite-error").textContent).toMatch(/Missing invite token/i);
    expect(screen.getByTestId("accept-invite-submit")).toBeDisabled();
  });

  it("weak password: inline error, no fetch", async () => {
    mockGetParam.mockReturnValue("tok");
    render(<AcceptInvitePage />);
    fireEvent.change(screen.getByTestId("accept-invite-password"), { target: { value: "short" } });
    fireEvent.change(screen.getByTestId("accept-invite-confirm"), { target: { value: "short" } });
    // The native required + minLength prevents form submit; bypass via the click→handler path.
    // The handler also enforces the rule, so we verify it shows the error if HTML5 validation is bypassed.
    const form = screen.getByTestId("accept-invite-form") as HTMLFormElement;
    fireEvent.submit(form);
    await waitFor(() =>
      expect(screen.getByTestId("accept-invite-error").textContent).toMatch(/at least 8/i),
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("mismatched confirm: inline error, no fetch", async () => {
    mockGetParam.mockReturnValue("tok");
    render(<AcceptInvitePage />);
    fireEvent.change(screen.getByTestId("accept-invite-password"), { target: { value: "supersecret1" } });
    fireEvent.change(screen.getByTestId("accept-invite-confirm"), { target: { value: "supersecret2" } });
    fireEvent.submit(screen.getByTestId("accept-invite-form"));
    await waitFor(() =>
      expect(screen.getByTestId("accept-invite-error").textContent).toMatch(/don't match/i),
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("happy path: POSTs to /api/team/accept, redirects to /login?invited=1&email=<invited>", async () => {
    mockGetParam.mockReturnValue("tok");
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      jsonResponse(200, { member_id: "tm_x", email: "max@thewolfpack.agency" }),
    );

    render(<AcceptInvitePage />);
    fireEvent.change(screen.getByTestId("accept-invite-password"), { target: { value: "supersecret" } });
    fireEvent.change(screen.getByTestId("accept-invite-confirm"), { target: { value: "supersecret" } });
    fireEvent.submit(screen.getByTestId("accept-invite-form"));

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith("/login?invited=1&email=max%40thewolfpack.agency"),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/team/accept",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: "tok", password: "supersecret" }),
      }),
    );
  });

  it("happy path with no email in response (shadow mode): redirects to /login?invited=1 without email", async () => {
    mockGetParam.mockReturnValue("tok");
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse(200, { member_id: "tm_x" }));

    render(<AcceptInvitePage />);
    fireEvent.change(screen.getByTestId("accept-invite-password"), { target: { value: "supersecret" } });
    fireEvent.change(screen.getByTestId("accept-invite-confirm"), { target: { value: "supersecret" } });
    fireEvent.submit(screen.getByTestId("accept-invite-form"));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/login?invited=1"));
  });

  it("no Display name input is rendered (iOS Safari autofill regression guard)", () => {
    mockGetParam.mockReturnValue("tok");
    render(<AcceptInvitePage />);
    expect(screen.queryByLabelText(/display name/i)).toBeNull();
    // The "you'll sign in with the email this invite was sent to" hint
    // is the single source of truth for what email to use on /login.
    expect(screen.getByText(/email this invite was sent to/i)).toBeInTheDocument();
  });

  it("server error: inline error, no redirect", async () => {
    mockGetParam.mockReturnValue("tok");
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse(404, { error: "Invalid or expired invite token" }));

    render(<AcceptInvitePage />);
    fireEvent.change(screen.getByTestId("accept-invite-password"), { target: { value: "supersecret" } });
    fireEvent.change(screen.getByTestId("accept-invite-confirm"), { target: { value: "supersecret" } });
    fireEvent.submit(screen.getByTestId("accept-invite-form"));

    await waitFor(() =>
      expect(screen.getByTestId("accept-invite-error").textContent).toMatch(/expired/i),
    );
    expect(mockPush).not.toHaveBeenCalled();
  });
});
