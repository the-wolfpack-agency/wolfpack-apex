/** @jest-environment jsdom */
import "@testing-library/jest-dom";

/**
 * UI test for the dashboard alert-address panel: renders each status, sends the
 * tenant token header, change (PUT) shows the confirmation-sent message, a 403
 * not_allowed shows the build-phase message, remove (DELETE) clears it, and a
 * load failure shows an explicit error instead of a blank panel.
 */
const mockFetch = jest.fn();
beforeAll(() => { (global as { fetch: unknown }).fetch = (...a: unknown[]) => mockFetch(...a); });

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AlertEmailPanel } from "../AlertEmailPanel";

const resp = (status: number, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
const state = (notify: unknown) => resp(200, { ok: true, notify });

beforeEach(() => jest.clearAllMocks());

it("shows a confirmed address and sends the tenant token", async () => {
  mockFetch.mockResolvedValueOnce(state({ email: "qa@thewolfpack.agency", status: "confirmed", confirmedAt: "x" }));
  render(<AlertEmailPanel token="ff_tok" site="acme.com" />);
  expect(await screen.findByTestId("ff-alert-status")).toHaveTextContent("Alerts on");
  expect(screen.getByTestId("ff-alert-address")).toHaveTextContent("qa@thewolfpack.agency");
  expect(((mockFetch.mock.calls[0][1] as RequestInit).headers as Record<string, string>)["x-forcefield-token"]).toBe("ff_tok");
});

it("empty state offers to add an address", async () => {
  mockFetch.mockResolvedValueOnce(state({ email: null, status: null, confirmedAt: null }));
  render(<AlertEmailPanel token="ff_tok" site="acme.com" />);
  expect(await screen.findByTestId("ff-alert-status")).toHaveTextContent("No alert email");
  expect(screen.getByTestId("ff-alert-change")).toHaveTextContent(/Add an alert email/);
  expect(screen.queryByTestId("ff-alert-remove")).not.toBeInTheDocument();
});

it("changing the address PUTs it and reports the confirmation email", async () => {
  mockFetch
    .mockResolvedValueOnce(state({ email: "qa@thewolfpack.agency", status: "confirmed", confirmedAt: "x" }))
    .mockResolvedValueOnce(resp(200, { ok: true, status: "pending", delivered: true }))
    .mockResolvedValueOnce(state({ email: "new@thewolfpack.agency", status: "pending", confirmedAt: null }));
  render(<AlertEmailPanel token="ff_tok" site="acme.com" />);
  fireEvent.click(await screen.findByTestId("ff-alert-change"));
  fireEvent.change(screen.getByTestId("ff-alert-input"), { target: { value: "new@thewolfpack.agency" } });
  fireEvent.click(screen.getByTestId("ff-alert-save"));
  expect(await screen.findByTestId("ff-alert-message")).toHaveTextContent(/Confirmation email sent to new@thewolfpack.agency/);
  const put = mockFetch.mock.calls[1];
  expect((put[1] as RequestInit).method).toBe("PUT");
  expect(JSON.parse((put[1] as RequestInit).body as string)).toEqual({ email: "new@thewolfpack.agency" });
  await waitFor(() => expect(screen.getByTestId("ff-alert-status")).toHaveTextContent("Waiting for confirmation"));
});

it("a non-allowlisted address (403) shows the restriction message", async () => {
  mockFetch
    .mockResolvedValueOnce(state({ email: null, status: null, confirmedAt: null }))
    .mockResolvedValueOnce(resp(403, { ok: false, error: "not_allowed" }));
  render(<AlertEmailPanel token="ff_tok" site="acme.com" />);
  fireEvent.click(await screen.findByTestId("ff-alert-change"));
  fireEvent.change(screen.getByTestId("ff-alert-input"), { target: { value: "owner@client.example" } });
  fireEvent.click(screen.getByTestId("ff-alert-save"));
  expect(await screen.findByTestId("ff-alert-message")).toHaveTextContent(/cannot receive Forcefield alerts yet/);
});

it("remove DELETEs and the panel reloads to the empty state", async () => {
  mockFetch
    .mockResolvedValueOnce(state({ email: "qa@thewolfpack.agency", status: "pending", confirmedAt: null }))
    .mockResolvedValueOnce(resp(200, { ok: true }))
    .mockResolvedValueOnce(state({ email: null, status: null, confirmedAt: null }));
  render(<AlertEmailPanel token="ff_tok" site="acme.com" />);
  expect(await screen.findByTestId("ff-alert-resend")).toBeInTheDocument();
  fireEvent.click(screen.getByTestId("ff-alert-remove"));
  expect(await screen.findByTestId("ff-alert-message")).toHaveTextContent(/removed/);
  expect((mockFetch.mock.calls[1][1] as RequestInit).method).toBe("DELETE");
  await waitFor(() => expect(screen.getByTestId("ff-alert-status")).toHaveTextContent("No alert email"));
});

it("a load failure shows an explicit error", async () => {
  mockFetch.mockResolvedValueOnce(resp(503, { ok: false }));
  render(<AlertEmailPanel token="ff_tok" site="acme.com" />);
  expect(await screen.findByTestId("ff-alert-error")).toBeInTheDocument();
});
