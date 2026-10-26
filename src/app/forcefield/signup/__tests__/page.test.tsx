/** @jest-environment jsdom */
import "@testing-library/jest-dom";

/**
 * UI test for the public Forcefield start page (onboarding step 1). Proves the
 * form POSTs the site + alert email to /api/forcefield/onboarding; a 201
 * self-serve answer stores the setup key and continues to /forcefield/setup; a
 * 202 (build phase, non-allowlisted address) shows "request received"; 429 and
 * 400 show clear messages; no token is ever shown on this page.
 */
const mockFetch = jest.fn();
const mockPush = jest.fn();
beforeAll(() => { (global as { fetch: unknown }).fetch = (...a: unknown[]) => mockFetch(...a); });
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ForcefieldSignupPage from "../page";

const resp = (status: number, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

beforeEach(() => { jest.clearAllMocks(); window.localStorage.clear(); });

function fill(email = "qa@thewolfpack.agency") {
  fireEvent.change(screen.getByTestId("ff-s-site"), { target: { value: "acme.com" } });
  fireEvent.change(screen.getByTestId("ff-s-email"), { target: { value: email } });
  fireEvent.change(screen.getByTestId("ff-s-name"), { target: { value: "Acme" } });
}

it("self-serve: stores the setup key and continues to /forcefield/setup", async () => {
  mockFetch.mockResolvedValueOnce(resp(201, { ok: true, mode: "self_serve", setupKey: "ffs_abc", site: "acme.com" }));
  render(<ForcefieldSignupPage />);
  fill();
  fireEvent.click(screen.getByTestId("ff-s-submit"));
  await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/forcefield/setup"));
  const [url, init] = mockFetch.mock.calls[0];
  expect(url).toBe("/api/forcefield/onboarding");
  expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ siteUrl: "acme.com", email: "qa@thewolfpack.agency", name: "Acme" });
  expect(window.localStorage.getItem("ff_setup_key")).toBe("ffs_abc");
  expect(document.body.textContent).not.toMatch(/ffs_|ff_[A-Za-z0-9]/);
});

it("build phase: a 202 request shows the received state and does not navigate", async () => {
  mockFetch.mockResolvedValueOnce(resp(202, { ok: true, mode: "request" }));
  render(<ForcefieldSignupPage />);
  fill("dana@acme.com");
  fireEvent.click(screen.getByTestId("ff-s-submit"));
  expect(await screen.findByTestId("ff-signup-done")).toBeInTheDocument();
  expect(mockPush).not.toHaveBeenCalled();
  expect(window.localStorage.getItem("ff_setup_key")).toBeNull();
});

it("shows a clear message when rate limited (429)", async () => {
  mockFetch.mockResolvedValueOnce(resp(429, { ok: false }));
  render(<ForcefieldSignupPage />);
  fill();
  fireEvent.click(screen.getByTestId("ff-s-submit"));
  expect(await screen.findByTestId("ff-signup-error")).toHaveTextContent(/too many requests/i);
  expect(screen.queryByTestId("ff-signup-done")).not.toBeInTheDocument();
});

it("shows a validation message on 400", async () => {
  mockFetch.mockResolvedValueOnce(resp(400, { ok: false }));
  render(<ForcefieldSignupPage />);
  fill();
  fireEvent.click(screen.getByTestId("ff-s-submit"));
  await waitFor(() => expect(screen.getByTestId("ff-signup-error")).toHaveTextContent(/valid email/i));
});

it("shows a retry message when the service is unavailable (503)", async () => {
  mockFetch.mockResolvedValueOnce(resp(503, { ok: false }));
  render(<ForcefieldSignupPage />);
  fill();
  fireEvent.click(screen.getByTestId("ff-s-submit"));
  expect(await screen.findByTestId("ff-signup-error")).toHaveTextContent(/try again/i);
});
