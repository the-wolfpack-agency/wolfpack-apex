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
const mockRouterReplace = jest.fn();
const mockGetParam = jest.fn<string | null, [string]>();

jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockRouterReplace, push: jest.fn() }),
  useSearchParams: () => ({ get: (k: string) => mockGetParam(k) }),
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
  mockRouterReplace.mockReset();
  /* Default to no pending_scan param — individual tests opt in by
     overriding mockGetParam. */
  mockGetParam.mockReset();
  mockGetParam.mockReturnValue(null);
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

  /* Inline-edit (D/E/F) behavior — pins the policy that the table
     surfaces an editable input ONLY for Program / PO Number / PO
     Amount, and that blur fires a PATCH to /api/job-codes/[code]/cell
     with the correct column letter. */
  it("renders an editable input for Program (column D) and PATCHes on blur with the right body", async () => {
    const codeRow = {
      code: "WOLFPACK-AUTO",
      description: "Dealer DOS engineering",
      sheetName: "Job Codes",
      active: true,
      lastSeenAt: "2026-05-21",
      extra: { "Client/Category": "Acme", "Program": "OLD", "PO Number": "PO-1", "PO Amount": "100" },
    };
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkRes({ capabilities: ["jobcodes.view", "jobcodes.refresh"] }))
      .mockResolvedValueOnce(mkRes({
        codes: [codeRow],
        columns: ["Code", "Description", "Client/Category", "Program", "PO Number", "PO Amount"],
        source: freshSource(),
        served_stale: false,
      }))
      .mockResolvedValueOnce(mkRes({})) // analytics page_viewed
      .mockResolvedValueOnce(mkRes({
        ok: true,
        code: "WOLFPACK-AUTO",
        column: "D",
        column_header: "Program",
        cell_address: "D7",
        previous_value: "OLD",
        new_value: "Phase 2",
      })) // PATCH response
      .mockResolvedValue(mkRes({}));

    await act(async () => {
      render(<JobCodesTable />);
    });

    /* Read-only header for Code/Description, editable mark on Program. */
    await waitFor(() => expect(screen.getByTestId("job-codes-header-Program")).toHaveTextContent(/editable/i));
    expect(screen.queryByTestId("job-codes-header-Code")).not.toHaveTextContent(/editable/i);

    /* Program cell renders as an input (editable column). */
    const input = await screen.findByTestId("cell-input-WOLFPACK-AUTO-Program");
    expect(input).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe("OLD");

    /* Client/Category cell renders as plain text (NOT an input). */
    expect(screen.queryByTestId("cell-input-WOLFPACK-AUTO-Client/Category")).not.toBeInTheDocument();
    expect(screen.getByTestId("cell-WOLFPACK-AUTO-Client/Category")).toHaveTextContent("Acme");

    /* Edit + blur → PATCH fires with column=D and the new value. */
    fireEvent.change(input, { target: { value: "Phase 2" } });
    await act(async () => {
      fireEvent.blur(input);
    });

    const patchCall = mockFetchWithRefresh.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("/api/job-codes/WOLFPACK-AUTO/cell"),
    );
    expect(patchCall).toBeDefined();
    const body = JSON.parse((patchCall![1] as { body: string }).body);
    /* The body now also carries `expected_value` for the optimistic-
       concurrency gate added in 2026-05-21 (the cell's mounted value
       was "OLD"). */
    expect(body).toEqual({ column: "D", value: "Phase 2", expected_value: "OLD" });
  });

  it("renders read-only text (no input) when caller lacks jobcodes.refresh", async () => {
    const codeRow = {
      code: "X-1",
      description: "x",
      sheetName: "Job Codes",
      active: true,
      lastSeenAt: "2026-05-21",
      extra: { "Program": "P1" },
    };
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkRes({ capabilities: ["jobcodes.view"] })) // no refresh
      .mockResolvedValueOnce(mkRes({
        codes: [codeRow],
        columns: ["Code", "Description", "Program"],
        source: freshSource(),
        served_stale: false,
      }))
      .mockResolvedValue(mkRes({}));
    await act(async () => {
      render(<JobCodesTable />);
    });
    await waitFor(() => expect(screen.getByTestId("cell-X-1-Program")).toBeInTheDocument());
    /* Read-only: no input, just the value as text. */
    expect(screen.queryByTestId("cell-input-X-1-Program")).not.toBeInTheDocument();
  });

  /* Cross-page intake router: a receipt scanned on /finance/invoices
     bounces here with ?pending_scan=<id>. JobCodesTable forwards the
     param to ReceiptUploadButton which GETs the rehydrated fields
     and opens the apply modal — no second Azure transaction. */
  it("auto-opens the apply modal pre-loaded when ?pending_scan=<id> is in the URL", async () => {
    mockGetParam.mockImplementation((k: string) => (k === "pending_scan" ? "scan-from-invoices" : null));
    const fields = {
      merchantName: "Acme Hardware",
      transactionDate: "2026-05-21",
      total: 124.5,
      subtotal: null,
      tax: null,
      currency: "USD",
      items: [],
      documentConfidence: 0.92,
      rawText: "",
    };
    /* URL-routed mock — analytics fire-and-forget interleaves with
       the rehydrate GET, so we can't use a strict in-order queue here. */
    mockFetchWithRefresh.mockImplementation((url: string) => {
      if (url === "/api/me/capabilities") {
        return Promise.resolve(mkRes({ capabilities: ["jobcodes.view", "jobcodes.refresh"] }));
      }
      if (url === "/api/job-codes") {
        return Promise.resolve(mkRes({ codes: sampleCodes(), source: freshSource(), served_stale: false }));
      }
      if (url.includes("/api/job-codes/scan-receipt/scan-from-invoices")) {
        return Promise.resolve(mkRes({ ok: true, scan_id: "scan-from-invoices", fields }));
      }
      return Promise.resolve(mkRes({}));
    });

    await act(async () => {
      render(<JobCodesTable />);
    });

    /* Apply modal opens with the rehydrated merchant visible. */
    await waitFor(() => expect(screen.getByTestId("receipt-extracted-summary")).toBeInTheDocument());
    expect(screen.getByTestId("receipt-extracted-summary")).toHaveTextContent("Acme Hardware");

    /* Rehydrate endpoint was hit with the URL-supplied id. */
    const rehydrate = mockFetchWithRefresh.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("/api/job-codes/scan-receipt/scan-from-invoices"),
    );
    expect(rehydrate).toBeDefined();

    /* URL param scrubbed via router.replace so refresh doesn't
       re-open the modal forever. */
    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalled());
  });

  it("does NOT auto-open the apply modal when ?pending_scan is absent", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkRes({ capabilities: ["jobcodes.view", "jobcodes.refresh"] }))
      .mockResolvedValueOnce(mkRes({ codes: sampleCodes(), source: freshSource(), served_stale: false }))
      .mockResolvedValue(mkRes({}));
    await act(async () => {
      render(<JobCodesTable />);
    });
    await waitFor(() => expect(screen.getByTestId("job-code-row-WOLFPACK-AUTO")).toBeInTheDocument());
    expect(screen.queryByTestId("receipt-extracted-summary")).not.toBeInTheDocument();
    /* And we didn't fire a rehydrate GET. */
    const rehydrate = mockFetchWithRefresh.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("/api/job-codes/scan-receipt/"),
    );
    expect(rehydrate).toBeUndefined();
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

  /* Concurrency: 2026-05-21 — a 409 from the cell PATCH surfaces a
     blocking conflict dialog. Overwrite re-PATCHes WITHOUT
     expected_value; Keep theirs swaps the table value. */
  it("409 from cell PATCH opens ConflictDialog; Overwrite re-PATCHes without expected_value", async () => {
    const codeRow = {
      code: "WPA-1",
      description: "Wolfpack Auto",
      sheetName: "Job Codes",
      active: true,
      lastSeenAt: "2026-05-21",
      extra: { "Client/Category": "Acme", "Program": "OLD", "PO Number": "PO-1", "PO Amount": "100" },
    };
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkRes({ capabilities: ["jobcodes.view", "jobcodes.refresh"] }))
      .mockResolvedValueOnce(mkRes({
        codes: [codeRow],
        columns: ["Code", "Description", "Client/Category", "Program", "PO Number", "PO Amount"],
        source: freshSource(),
        served_stale: false,
      }))
      .mockResolvedValueOnce(mkRes({})) // analytics page_viewed
      .mockResolvedValueOnce(mkRes({})) // analytics cell_edit_started (first attempt)
      /* First PATCH → 409 conflict. */
      .mockResolvedValueOnce(mkRes(
        {
          error: "conflict",
          conflicts: [{
            column: "Program",
            currentValue: "HOXSIE-VALUE",
            expectedValue: "OLD",
            requestedValue: "MINE",
          }],
        },
        { ok: false, status: 409 },
      ))
      .mockResolvedValueOnce(mkRes({})) // analytics conflict_resolved
      .mockResolvedValueOnce(mkRes({})) // analytics cell_edit_started (overwrite)
      .mockResolvedValue(mkRes({ ok: true, new_value: "MINE" })); // overwrite PATCH + trailing analytics

    await act(async () => {
      render(<JobCodesTable />);
    });
    const input = await screen.findByTestId("cell-input-WPA-1-Program");
    fireEvent.change(input, { target: { value: "MINE" } });
    await act(async () => {
      fireEvent.blur(input);
    });
    /* Dialog opens. */
    await waitFor(() => expect(screen.getByTestId("conflict-dialog")).toBeInTheDocument());
    expect(screen.getByTestId("conflict-current-Program").textContent).toBe("HOXSIE-VALUE");

    /* Overwrite → triggers a second PATCH without expected_value. */
    await act(async () => {
      fireEvent.click(screen.getByTestId("conflict-overwrite"));
    });

    const patchCalls = mockFetchWithRefresh.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("/api/job-codes/WPA-1/cell"),
    );
    expect(patchCalls.length).toBe(2);
    const firstBody = JSON.parse((patchCalls[0][1] as { body: string }).body);
    expect(firstBody).toMatchObject({ column: "D", value: "MINE", expected_value: "OLD" });
    const overwriteBody = JSON.parse((patchCalls[1][1] as { body: string }).body);
    expect(overwriteBody).toEqual({ column: "D", value: "MINE" });
  });

  it("Keep theirs on conflict adopts the server value into the table, no second PATCH", async () => {
    const codeRow = {
      code: "WPA-1",
      description: "Wolfpack Auto",
      sheetName: "Job Codes",
      active: true,
      lastSeenAt: "2026-05-21",
      extra: { "Program": "OLD" },
    };
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkRes({ capabilities: ["jobcodes.view", "jobcodes.refresh"] }))
      .mockResolvedValueOnce(mkRes({
        codes: [codeRow],
        columns: ["Code", "Description", "Program"],
        source: freshSource(),
        served_stale: false,
      }))
      .mockResolvedValueOnce(mkRes({})) // analytics page_viewed
      .mockResolvedValueOnce(mkRes({})) // analytics cell_edit_started
      .mockResolvedValueOnce(mkRes(
        {
          error: "conflict",
          conflicts: [{
            column: "Program",
            currentValue: "HOXSIE",
            expectedValue: "OLD",
            requestedValue: "MINE",
          }],
        },
        { ok: false, status: 409 },
      ))
      .mockResolvedValue(mkRes({}));

    await act(async () => {
      render(<JobCodesTable />);
    });
    const input = await screen.findByTestId("cell-input-WPA-1-Program");
    fireEvent.change(input, { target: { value: "MINE" } });
    await act(async () => { fireEvent.blur(input); });

    await waitFor(() => expect(screen.getByTestId("conflict-dialog")).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId("conflict-keep-theirs"));
    });
    expect(screen.queryByTestId("conflict-dialog")).not.toBeInTheDocument();

    /* Only one PATCH — the second never fires. */
    const patchCalls = mockFetchWithRefresh.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("/api/job-codes/WPA-1/cell"),
    );
    expect(patchCalls.length).toBe(1);
  });
});
