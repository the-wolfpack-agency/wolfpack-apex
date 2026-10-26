/** @jest-environment jsdom */
import "@testing-library/jest-dom";

/**
 * UI test for /forcefield/unsubscribe: nothing is POSTed on load (a mail scanner that
 * prefetches the link changes nothing); one click POSTs the token from ?token=;
 * success and each error code render a clear message; a missing token says so.
 */
const mockFetch = jest.fn();
beforeAll(() => { (global as { fetch: unknown }).fetch = (...a: unknown[]) => mockFetch(...a); });

import { render, screen, fireEvent } from "@testing-library/react";
import Page from "../page";

const resp = (status: number, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

function at(search: string) {
  window.history.replaceState({}, "", `/forcefield/unsubscribe${search}`);
}

beforeEach(() => jest.clearAllMocks());

it("does nothing on load and POSTs the token on click", async () => {
  at("?token=tok.abc");
  mockFetch.mockResolvedValueOnce(resp(200, { ok: true, site: "acme.com" }));
  render(<Page />);
  const button = await screen.findByTestId("ff-unsub-button");
  expect(mockFetch).not.toHaveBeenCalled();
  fireEvent.click(button);
  expect(await screen.findByTestId("ff-unsub-done")).toHaveTextContent("acme.com");
  const [url, init] = mockFetch.mock.calls[0];
  expect(url).toBe("/api/forcefield/alert-email/unsubscribe");
  expect(JSON.parse((init as RequestInit).body as string)).toEqual({ token: "tok.abc" });
});

it.each([[410, "expired", /expired/i], [400, "invalid", /not valid/i], [503, "error", /try again/i]])("HTTP %s (%s) shows a clear message", async (status, error, text) => {
  at("?token=tok.abc");
  mockFetch.mockResolvedValueOnce(resp(status as number, { ok: false, error }));
  render(<Page />);
  fireEvent.click(await screen.findByTestId("ff-unsub-button"));
  expect(await screen.findByTestId("ff-unsub-error")).toHaveTextContent(text as RegExp);
});

it("a link without a token says it is incomplete", async () => {
  at("");
  render(<Page />);
  expect(await screen.findByTestId("ff-unsub-missing")).toBeInTheDocument();
  expect(screen.queryByTestId("ff-unsub-button")).not.toBeInTheDocument();
});

it("links back to the client dashboard, never /admin", async () => {
  at("?token=t");
  render(<Page />);
  await screen.findByTestId("ff-unsub-button");
  const hrefs = Array.from(document.querySelectorAll("a")).map((a) => a.getAttribute("href"));
  expect(hrefs).toContain("/forcefield/dashboard");
  expect(hrefs.some((h) => h?.startsWith("/admin"))).toBe(false);
});
