/** @jest-environment jsdom */
import "@testing-library/jest-dom";

/**
 * UI test for the public Forcefield start page (onboarding step 1). Proves the
 * form POSTs the site + alert email to /api/forcefield/onboarding; a 201
 * self-serve answer stores the setup key and shows the one install option for
 * the detected platform (WordPress plugin, Next.js on Vercel, or "connect it
 * for me"); a
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

it("self-serve: stores the setup key and shows the install step for the detected platform", async () => {
  mockFetch.mockResolvedValueOnce(resp(201, { ok: true, mode: "self_serve", setupKey: "ffs_abc", site: "acme.com", email: "qa@thewolfpack.agency", platform: "wordpress" }));
  render(<ForcefieldSignupPage />);
  fill();
  fireEvent.click(screen.getByTestId("ff-s-submit"));
  const install = await screen.findByTestId("ff-install");
  expect(install).toHaveAttribute("data-platform", "wordpress");
  expect(install).toHaveTextContent("acme.com runs WordPress");
  expect(install).toHaveTextContent("qa@thewolfpack.agency");
  expect(screen.getByTestId("ff-install-wordpress-button")).toHaveAttribute("href", "/api/forcefield/wordpress/plugin");
  expect(screen.getByTestId("ff-install-wordpress-upload")).toHaveAttribute("href", "https://acme.com/wp-admin/plugin-install.php?tab=upload");
  expect(mockPush).not.toHaveBeenCalled();
  const [url, init] = mockFetch.mock.calls[0];
  expect(url).toBe("/api/forcefield/onboarding");
  expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ siteUrl: "acme.com", email: "qa@thewolfpack.agency", name: "Acme" });
  expect(window.localStorage.getItem("ff_setup_key")).toBe("ffs_abc");
  expect(document.body.textContent).not.toMatch(/ffs_|ff_[A-Za-z0-9]/);
  // The DNS / file path stays one click away.
  fireEvent.click(screen.getByTestId("ff-install-setup"));
  expect(mockPush).toHaveBeenCalledWith("/forcefield/setup");
});

it("Next.js on Vercel: the option continues to the guided setup", async () => {
  mockFetch.mockResolvedValueOnce(resp(201, { ok: true, mode: "self_serve", setupKey: "ffs_v", site: "acme.com", platform: "vercel" }));
  render(<ForcefieldSignupPage />);
  fill();
  fireEvent.click(screen.getByTestId("ff-s-submit"));
  expect(await screen.findByTestId("ff-install-vercel")).toBeInTheDocument();
  expect(screen.queryByTestId("ff-install-wordpress")).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId("ff-install-vercel-button"));
  expect(mockPush).toHaveBeenCalledWith("/forcefield/setup");
});

it("other: 'Connect it for me' files the concierge request with the setup key", async () => {
  mockFetch.mockResolvedValueOnce(resp(201, { ok: true, mode: "self_serve", setupKey: "ffs_o", site: "acme.com", email: "qa@thewolfpack.agency", platform: "other" }));
  mockFetch.mockResolvedValueOnce(resp(200, { ok: true }));
  render(<ForcefieldSignupPage />);
  fill();
  fireEvent.click(screen.getByTestId("ff-s-submit"));
  fireEvent.click(await screen.findByTestId("ff-install-concierge"));
  expect(await screen.findByTestId("ff-install-concierge-done")).toHaveTextContent("qa@thewolfpack.agency");
  const [url, init] = mockFetch.mock.calls[1];
  expect(url).toBe("/api/forcefield/onboarding/concierge");
  expect((init as RequestInit).headers).toMatchObject({ "x-forcefield-setup": "ffs_o" });
});

it("an unknown platform value falls back to the concierge option", async () => {
  mockFetch.mockResolvedValueOnce(resp(201, { ok: true, mode: "self_serve", setupKey: "ffs_x", site: "acme.com", platform: "joomla" }));
  render(<ForcefieldSignupPage />);
  fill();
  fireEvent.click(screen.getByTestId("ff-s-submit"));
  expect(await screen.findByTestId("ff-install-other")).toBeInTheDocument();
});

it("submit is disabled until both the website and the email are filled", async () => {
  render(<ForcefieldSignupPage />);
  const submit = screen.getByTestId("ff-s-submit");
  await waitFor(() => expect(submit).toBeDisabled());
  fireEvent.change(screen.getByTestId("ff-s-site"), { target: { value: "acme.com" } });
  expect(submit).toBeDisabled();
  fireEvent.change(screen.getByTestId("ff-s-email"), { target: { value: "qa@thewolfpack.agency" } });
  await waitFor(() => expect(submit).toBeEnabled());
  fireEvent.change(screen.getByTestId("ff-s-site"), { target: { value: "  " } });
  expect(submit).toBeDisabled();
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
