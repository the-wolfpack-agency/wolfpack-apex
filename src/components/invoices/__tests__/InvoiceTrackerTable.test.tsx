/**
 * @jest-environment jsdom
 *
 * UI tests for the read-only invoice mirror (styled to match /job-codes). Covers
 * every state so the page never blanks: loading, forbidden (403 -> clean
 * message, not an empty grid), rendered rows/columns, the freshness chip
 * (fresh/stale), search filtering, empty-with-hint, and the manual refresh
 * success + error paths. Fetches are mocked at fetchWithRefresh (the repo's
 * required client wrapper).
 */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
}));

import { InvoiceTrackerTable } from "@/components/invoices/InvoiceTrackerTable";

function jsonRes(body: unknown, init: { status?: number; ok?: boolean } = {}) {
  const status = init.status ?? 200;
  return { ok: init.ok ?? (status >= 200 && status < 300), status, json: async () => body };
}

const payload = {
  company: "PCNA",
  sheet: "Summary",
  columns: ["Invoice", "Amount"],
  rows: [
    { Invoice: "INV-1", Amount: "1000" },
    { Invoice: "INV-2", Amount: "2500" },
  ],
  source: "fresh",
  served_stale: false,
  last_refreshed_at: new Date().toISOString(),
  web_url: "https://host/file",
  error_code: null,
};

beforeEach(() => jest.resetAllMocks());

test("renders the sheet's columns and rows with a source link and fresh chip", async () => {
  mockFetch.mockResolvedValueOnce(jsonRes(payload));
  render(<InvoiceTrackerTable company="pcna" />);

  await screen.findByTestId("invoice-tracker-table");
  expect(screen.getByText("Invoice")).toBeInTheDocument();
  expect(screen.getByText("INV-1")).toBeInTheDocument();
  expect(screen.getByText("2500")).toBeInTheDocument();
  expect(screen.getAllByTestId("invoice-tracker-row")).toHaveLength(2);
  expect(screen.getByTestId("invoice-tracker-open")).toHaveAttribute("href", "https://host/file");
  expect(screen.getByTestId("invoice-tracker-freshness").textContent).toMatch(/synced/i);
});

test("filters rows via the search box", async () => {
  mockFetch.mockResolvedValueOnce(jsonRes(payload));
  render(<InvoiceTrackerTable company="pcna" />);
  await screen.findByTestId("invoice-tracker-table");

  fireEvent.change(screen.getByTestId("invoice-tracker-search"), { target: { value: "INV-2" } });
  expect(screen.getByText("INV-2")).toBeInTheDocument();
  expect(screen.queryByText("INV-1")).not.toBeInTheDocument();

  fireEvent.change(screen.getByTestId("invoice-tracker-search"), { target: { value: "zzz" } });
  expect(screen.getByTestId("invoice-tracker-no-match")).toBeInTheDocument();
});

test("shows a clean forbidden message on 403 (not an empty grid)", async () => {
  mockFetch.mockResolvedValueOnce(jsonRes({ error: "forbidden" }, { status: 403 }));
  render(<InvoiceTrackerTable company="pcna" />);

  await screen.findByTestId("invoice-tracker-forbidden");
  expect(screen.queryByTestId("invoice-tracker-table")).not.toBeInTheDocument();
});

test("freshness chip flags a stale (last-synced) copy", async () => {
  mockFetch.mockResolvedValueOnce(jsonRes({ ...payload, source: "stale", served_stale: true }));
  render(<InvoiceTrackerTable company="pcna" />);

  const chip = await screen.findByTestId("invoice-tracker-freshness");
  expect(chip.textContent).toMatch(/stale/i);
});

test("shows an empty state with the error hint when there are no rows", async () => {
  mockFetch.mockResolvedValueOnce(jsonRes({ ...payload, rows: [], source: "empty", error_code: "no_token" }));
  render(<InvoiceTrackerTable company="pcna" />);

  const empty = await screen.findByTestId("invoice-tracker-empty");
  expect(empty.textContent).toMatch(/Connect your Microsoft account/i);
});

test("refresh POSTs and replaces the rows on success", async () => {
  mockFetch
    .mockResolvedValueOnce(jsonRes(payload))
    .mockResolvedValueOnce(jsonRes({ ...payload, rows: [{ Invoice: "INV-9", Amount: "999" }] }));
  render(<InvoiceTrackerTable company="pcna" />);
  await screen.findByTestId("invoice-tracker-table");

  await act(async () => {
    fireEvent.click(screen.getByTestId("invoice-tracker-refresh"));
  });

  await waitFor(() => expect(screen.getByText("INV-9")).toBeInTheDocument());
  const [, refreshCall] = mockFetch.mock.calls;
  expect(refreshCall[0]).toBe("/api/invoices/pcna/refresh");
  expect(refreshCall[1]).toMatchObject({ method: "POST" });
});

test("surfaces a refresh error without wiping the current rows", async () => {
  mockFetch
    .mockResolvedValueOnce(jsonRes(payload))
    .mockResolvedValueOnce(jsonRes({ error: "refresh_failed", error_code: "graph_error" }, { status: 502 }));
  render(<InvoiceTrackerTable company="pcna" />);
  await screen.findByTestId("invoice-tracker-table");

  await act(async () => {
    fireEvent.click(screen.getByTestId("invoice-tracker-refresh"));
  });

  await screen.findByTestId("invoice-tracker-refresh-error");
  expect(screen.getByText("INV-1")).toBeInTheDocument();
});
