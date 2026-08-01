/**
 * @jest-environment jsdom
 */
/**
 * UI tests for /login page.
 *
 * Locked behaviors:
 *   - ?email=<addr> pre-fills the email input
 *   - ?invited=1 shows the "Account ready" banner; mentions the email
 *     when pre-filled so the operator knows which one to use
 *   - Email input has autoComplete="email" so iOS Safari doesn't fill
 *     it with the text from a previous unrelated text field (regression
 *     guard for the 2026-05-20 accept-invite → login bug)
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const assignMock = jest.fn();
jest.mock("@/lib/client-navigate", () => ({ hardNavigate: (p: string) => assignMock(p) }));

jest.mock("@/lib/client-auth", () => ({
  setInstinctSession: jest.fn(),
  // Added with the stuck-button fix. A mock that omits an export the component
  // calls does not fail loudly — the call throws, the component's catch turns
  // it into "Network error", and the test reports a missing session write. The
  // mock has to keep pace with the module.
  clearInstinctSession: jest.fn(),
  authHeaders: () => ({}),
  fetchWithRefresh: jest.fn(),
}));

const mockPush = jest.fn();

/* Navigation goes through a module so it can be mocked: jsdom makes
   window.location read-only, and a component calling it directly cannot be
   asserted on without fighting the environment. */
beforeEach(() => assignMock.mockClear());
const params = new Map<string, string>();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => ({ get: (k: string) => params.get(k) ?? null }),
}));

import { setInstinctSession, fetchWithRefresh } from "@/lib/client-auth";
import LoginPage from "@/app/login/page";

beforeEach(() => {
  jest.clearAllMocks();
  params.clear();
});

describe("LoginPage", () => {
  it("pre-fills the email field from ?email= query", () => {
    params.set("email", "max@thewolfpack.agency");
    params.set("invited", "1");
    render(<LoginPage />);
    const emailInput = screen.getByTestId("login-email") as HTMLInputElement;
    expect(emailInput.value).toBe("max@thewolfpack.agency");
  });

  it("shows the invited banner naming the pre-filled email", () => {
    params.set("invited", "1");
    params.set("email", "max@thewolfpack.agency");
    render(<LoginPage />);
    const banner = screen.getByTestId("invited-banner");
    expect(banner.textContent).toMatch(/Account ready/i);
    expect(banner.textContent).toMatch(/max@thewolfpack\.agency/);
  });

  it("invited banner without email still renders, with generic copy", () => {
    params.set("invited", "1");
    render(<LoginPage />);
    const banner = screen.getByTestId("invited-banner");
    expect(banner.textContent).toMatch(/Account ready/i);
    expect(banner.textContent).toMatch(/Sign in to continue/i);
  });

  it("no invited banner when ?invited!=1", () => {
    render(<LoginPage />);
    expect(screen.queryByTestId("invited-banner")).toBeNull();
  });

  it("email input has autoComplete='email' (iOS autofill regression guard)", () => {
    render(<LoginPage />);
    const emailInput = screen.getByTestId("login-email");
    expect(emailInput).toHaveAttribute("autocomplete", "email");
    expect(emailInput).toHaveAttribute("type", "email");
  });

  it("signs in via raw fetch, not fetchWithRefresh, so an expired session never blocks login", async () => {
    /* Regression guard for the stuck-grey-button bug: fetchWithRefresh
       pre-refreshes a stale token and, on failure, redirects back to /login,
       so sign-in never completes (only a private window worked). The login
       request must be a raw fetch. */
    const mockFetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "tok", user: { id: "u1" } }) })
      .mockResolvedValue({ ok: true, json: async () => ({}) });
    (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;

    render(<LoginPage />);
    fireEvent.change(screen.getByTestId("login-email"), { target: { value: "Cto@Wolfpack.dev" } });
    fireEvent.change(screen.getByTestId("login-password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(setInstinctSession as jest.Mock).toHaveBeenCalledWith("tok", { id: "u1" }));
    // Raw fetch to the login endpoint, with the email normalized to lowercase.
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/auth/login",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "cto@wolfpack.dev", password: "pw" }),
      }),
    );
    // It must NOT route through the token-refreshing wrapper.
    expect(fetchWithRefresh as jest.Mock).not.toHaveBeenCalled();
    // Hard navigation, not router.push: sign-in changes the auth cookies, and
    // a soft push reuses RSC payloads fetched before those cookies existed.
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("/assistant"));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("demo credentials block is hidden by default (no NEXT_PUBLIC_SHOW_DEMO_CREDS)", () => {
    /* Confusing in front of the team during onboarding + the seed
       accounts only work in shadow mode. Regression guard so a
       future commit doesn't accidentally unhide them. */
    render(<LoginPage />);
    expect(screen.queryByTestId("login-demo-credentials")).toBeNull();
    expect(screen.queryByText(/Demo Credentials/i)).toBeNull();
  });
});

/**
 * The stuck-button failure, reported from production 2026-08-01: the operator
 * signs in, the button reads "Signing in..." forever, and only a private
 * window works.
 *
 * The root cause was not reproducible from here — it needs the live session
 * state that a private window is missing. What IS a defect regardless of cause:
 * the success path never re-enabled the button, so ANY navigation that did not
 * complete left a dead control and no message. These tests pin the exits.
 */
describe("post-login navigation cannot dead-end", () => {
  it("hard-navigates rather than soft-pushing, so the new cookies are sent", async () => {
    // A soft push reuses RSC payloads fetched before sign-in, against the
    // session the user just replaced. A hard load cannot.
    const source = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "page.tsx"),
      "utf-8",
    );
    expect(source).toContain("hardNavigate(next)");
    expect(source).not.toMatch(/router\.push\(next\)/);
  });

  it("clears any prior client session before writing the new one", () => {
    const source = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "page.tsx"),
      "utf-8",
    );
    const clearAt = source.indexOf("clearInstinctSession()");
    const setAt = source.indexOf("setInstinctSession(data.token");
    expect(clearAt).toBeGreaterThan(-1);
    expect(clearAt).toBeLessThan(setAt);
  });

  it("arms a timeout that re-enables the button and says what to do", () => {
    // Without this the operator is left holding a control that does nothing
    // and shows nothing — which is exactly what was reported.
    const source = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "page.tsx"),
      "utf-8",
    );
    expect(source).toContain("NAVIGATION_TIMEOUT_MS");
    expect(source).toMatch(/setLoading\(false\)[\s\S]{0,400}clear this site's data/);
  });
});
