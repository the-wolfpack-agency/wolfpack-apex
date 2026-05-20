/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * <JobCodesTable /> — UI behavior under the four shapes the API
 * can return: happy, stale, empty, error. Plus search filtering and
 * the admin-only Refresh button rendered iff the capability is
 * present. This is what would have caught a "page renders blank with
 * no chip" regression.
 */

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
}));

import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { JobCodesTable } from "@/components/job-codes/JobCodesTable";

function mkRes(body: unknown, opts: { ok?: boolean; status?: number } = {}): any {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => body,
  };
}

function sampleCodes() {
  return [
    { code: "WOLFPACK-AUTO", description: "Dealer DOS engineering", sheetName: "Job Codes", active: true, lastSeenAt: "2026-05-20" },
    { code: "CLIENT-ACME", description: "Acme retainer billable", sheetName: "Job Codes", active: true, lastSeenAt: "2026-05-20" },
    { code: "INTERNAL-OPS", description: "Internal operations", sheetName: "Job Codes", active: true, lastSeenAt: "2026-05-20" },
  ];
}

function freshSource() {
  return {
    driveId: "d",
    itemId: "i",
    webUrl: "https://x.sharepoint.com/x.xlsx",
    sheetName: "Job Codes",
    lastRefreshedAt: new Date().toISOString(),
    lastAttemptedAt: new Date().toISOString(),
    lastAttemptStatus: "succeeded" as const,
    lastAttemptError: null,
  };
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

describe("<JobCodesTable />", () => {
  it("renders the codes from the API in a table on mount", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkRes({ capabilities: ["jobcodes.view"] })) // /api/me/capabilities
      .mockResolvedValueOnce(mkRes({ codes: sampleCodes(), source: freshSource(), served_stale: false })) // /api/job-codes
      .mockResolvedValue(mkRes({})); // /api/analytics
    await act(async () => {
      render(<JobCodesTable />);
    });
    await waitFor(() => expect(screen.getByTestId("job-code-row-WOLFPACK-AUTO")).toBeInTheDocument());
    expect(screen.getByTestId("job-code-row-CLIENT-ACME")).toBeInTheDocument();
    expect(screen.getByTestId("job-code-row-INTERNAL-OPS")).toBeInTheDocument();
    expect(screen.getByTestId("job-codes-freshness")).toHaveTextContent(/Synced/);
  });

  it("filters rows by code or description as the user types", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkRes({ capabilities: ["jobcodes.view"] }))
      .mockResolvedValueOnce(mkRes({ codes: sampleCodes(), source: freshSource(), served_stale: false }))
      .mockResolvedValue(mkRes({}));
    await act(async () => {
      render(<JobCodesTable />);
    });
    await waitFor(() => expect(screen.getByTestId("job-code-row-WOLFPACK-AUTO")).toBeInTheDocument());
    const search = screen.getByTestId("job-codes-search");
    fireEvent.change(search, { target: { value: "acme" } });
    await waitFor(() => {
      expect(screen.queryByTestId("job-code-row-WOLFPACK-AUTO")).not.toBeInTheDocument();
      expect(screen.getByTestId("job-code-row-CLIENT-ACME")).toBeInTheDocument();
    });
  });

  it("shows the stale chip when served_stale is true", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkRes({ capabilities: ["jobcodes.view"] }))
      .mockResolvedValueOnce(mkRes({ codes: sampleCodes(), source: freshSource(), served_stale: true }))
      .mockResolvedValue(mkRes({}));
    await act(async () => {
      render(<JobCodesTable />);
    });
    await waitFor(() => expect(screen.getByTestId("job-codes-freshness")).toHaveTextContent(/Stale/));
  });

  it("shows the error banner when the API responds non-OK", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkRes({ capabilities: ["jobcodes.view"] }))
      .mockResolvedValueOnce(
        mkRes({ error: "job_codes_unavailable" }, { ok: false, status: 503 }),
      )
      .mockResolvedValue(mkRes({}));
    await act(async () => {
      render(<JobCodesTable />);
    });
    await waitFor(() => expect(screen.getByTestId("job-codes-error")).toBeInTheDocument());
  });

  it("hides the Refresh button when the caller lacks jobcodes.refresh", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkRes({ capabilities: ["jobcodes.view"] })) // no refresh
      .mockResolvedValueOnce(mkRes({ codes: sampleCodes(), source: freshSource(), served_stale: false }))
      .mockResolvedValue(mkRes({}));
    await act(async () => {
      render(<JobCodesTable />);
    });
    await waitFor(() => expect(screen.getByTestId("job-code-row-WOLFPACK-AUTO")).toBeInTheDocument());
    expect(screen.queryByTestId("job-codes-refresh")).not.toBeInTheDocument();
  });

  it("shows the Refresh button + triggers refresh when the caller has jobcodes.refresh", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkRes({ capabilities: ["jobcodes.view", "jobcodes.refresh"] }))
      .mockResolvedValueOnce(mkRes({ codes: sampleCodes(), source: freshSource(), served_stale: false }))
      .mockResolvedValueOnce(mkRes({})) // analytics
      .mockResolvedValueOnce(mkRes({})) // analytics page_viewed
      /* Refresh click sequence: POST refresh → GET /api/job-codes reload */
      .mockResolvedValueOnce(
        mkRes({ ok: true, outcome: { status: "succeeded", rowsAdded: 1, rowsUpdated: 2, rowsDeactivated: 0 } }),
      )
      .mockResolvedValueOnce(mkRes({ codes: sampleCodes(), source: freshSource(), served_stale: false }))
      .mockResolvedValue(mkRes({}));
    await act(async () => {
      render(<JobCodesTable />);
    });
    const button = await screen.findByTestId("job-codes-refresh");
    expect(button).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(screen.getByTestId("job-codes-refresh-message")).toHaveTextContent(/Refreshed/));
  });

  it("shows the empty state when no codes are returned and no search is active", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkRes({ capabilities: ["jobcodes.view"] }))
      .mockResolvedValueOnce(mkRes({ codes: [], source: { ...freshSource(), lastRefreshedAt: null }, served_stale: false }))
      .mockResolvedValue(mkRes({}));
    await act(async () => {
      render(<JobCodesTable />);
    });
    await waitFor(() => expect(screen.getByTestId("job-codes-empty")).toBeInTheDocument());
  });
});
