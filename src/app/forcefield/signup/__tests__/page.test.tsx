/** @jest-environment jsdom */
import "@testing-library/jest-dom";

/**
 * UI test for the public Forcefield signup page. Proves the form POSTs the
 * fields to /api/forcefield/signup and shows the "received" success state on
 * 202, a clear message on 429/400, and that no token is ever shown (gated).
 */
const mockFetch = jest.fn();
beforeAll(() => { (global as { fetch: unknown }).fetch = (...a: unknown[]) => mockFetch(...a); });

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ForcefieldSignupPage from "../page";

const resp = (status: number, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

beforeEach(() => jest.clearAllMocks());

function fill() {
  fireEvent.change(screen.getByTestId("ff-s-name"), { target: { value: "Dana" } });
  fireEvent.change(screen.getByTestId("ff-s-email"), { target: { value: "dana@acme.com" } });
  fireEvent.change(screen.getByTestId("ff-s-site"), { target: { value: "acme.com" } });
}

it("submits the request and shows the received state (no token shown)", async () => {
  mockFetch.mockResolvedValueOnce(resp(202, { ok: true, status: "received" }));
  render(<ForcefieldSignupPage />);
  fill();
  fireEvent.click(screen.getByTestId("ff-s-submit"));

  expect(await screen.findByTestId("ff-signup-done")).toBeInTheDocument();
  const [url, init] = mockFetch.mock.calls[0];
  expect(url).toBe("/api/forcefield/signup");
  const sent = JSON.parse((init as RequestInit).body as string);
  expect(sent).toMatchObject({ name: "Dana", email: "dana@acme.com", siteUrl: "acme.com" });
  expect(document.body.textContent).not.toMatch(/ff_|token/i);
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
  await waitFor(() => expect(screen.getByTestId("ff-signup-error")).toHaveTextContent(/valid work email/i));
});
