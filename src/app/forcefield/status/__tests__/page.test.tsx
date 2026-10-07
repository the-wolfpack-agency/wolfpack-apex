/** @jest-environment jsdom */
import "@testing-library/jest-dom";

/**
 * UI test for the public Forcefield status page. Operational when the endpoint
 * reports ok, Degraded when the DB probe is down (not an error), an error note
 * when unreachable, and it always shows the fail-open guarantee. fetch is mocked.
 */
const mockFetch = jest.fn();
beforeAll(() => { (global as { fetch: unknown }).fetch = (...a: unknown[]) => mockFetch(...a); });

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import ForcefieldStatusPage from "../page";

const resp = (body: unknown, ok = true) => ({ ok, json: async () => body }) as unknown as Response;
beforeEach(() => jest.clearAllMocks());

it("shows All systems operational when the engine + DB are up", async () => {
  mockFetch.mockResolvedValueOnce(resp({ ok: true, status: "ok", engine: "ok", database: true, failOpen: true }));
  render(<ForcefieldStatusPage />);
  expect(await screen.findByText(/all systems operational/i)).toBeInTheDocument();
  expect(screen.getByTestId("ff-status-components")).toHaveTextContent(/engine/i);
  // the fail-open guarantee is always shown
  expect(screen.getByTestId("ff-status-failopen")).toHaveTextContent(/fails open/i);
});

it("shows Degraded (not an error) when the DB probe is down", async () => {
  mockFetch.mockResolvedValueOnce(resp({ ok: true, status: "degraded", engine: "ok", database: false, failOpen: true }));
  render(<ForcefieldStatusPage />);
  await waitFor(() => expect(screen.getByTestId("ff-status")).toHaveTextContent(/degraded/i));
  expect(screen.queryByTestId("ff-status-error")).not.toBeInTheDocument();
});

it("shows an error note when the status service is unreachable, and refresh re-checks", async () => {
  mockFetch.mockRejectedValueOnce(new Error("down"));
  render(<ForcefieldStatusPage />);
  expect(await screen.findByTestId("ff-status-error")).toBeInTheDocument();
  mockFetch.mockResolvedValueOnce(resp({ ok: true, status: "ok", engine: "ok", database: true, failOpen: true }));
  fireEvent.click(screen.getByTestId("ff-status-refresh"));
  await waitFor(() => expect(screen.getByText(/all systems operational/i)).toBeInTheDocument());
});
