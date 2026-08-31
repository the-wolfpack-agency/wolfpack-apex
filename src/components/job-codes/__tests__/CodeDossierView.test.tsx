/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * Pins the per-code dossier UI at every render branch:
 *   1. Loading state
 *   2. 404 → not_found branch with back-link
 *   3. Generic error
 *   4. Success → rollup cards + tabs (Receipts / Activity)
 *   5. PO Remaining negative → red tone
 *   6. Tab switch swaps content
 */

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
}));
/* next/link is server-component-heavy; the testing-library env is fine
   with the bare component but the default export needs to render
   children when called like a plain Link. */
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a>
  ),
}));

import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { CodeDossierView } from "@/components/job-codes/CodeDossierView";

function mkRes(body: unknown, opts: { ok?: boolean; status?: number } = {}): any {
  return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => body };
}

const sampleDossier = {
  header: {
    code: "WPA-1",
    description: "Wolfpack Auto program",
    active: true,
    category: "Wolfpack Auto",
    program: "Phase 2",
    poNumber: "PO-42",
    poAmount: "$3,500.00",
    poAmountNumeric: 3500,
    lastSeenAt: "2026-05-21T00:00:00.000Z",
    webUrl: "https://sp/x.xlsx",
  },
  rollups: {
    spendYtd: 150,
    spendMtd: 50,
    spendAllTime: 4000, // > PO Amount → negative remaining
    receiptCount: 2,
    poRemaining: -500,
    lastActivityAt: "2026-05-21T01:00:00.000Z",
  },
  receipts: [
    {
      scanId: "r-1",
      appliedAt: "2026-05-21T01:00:00.000Z",
      uploadedByEmail: "homyk@thewolfpack.agency",
      merchant: "Office Depot",
      transactionDate: "2026-05-20",
      total: 50,
      currency: "USD",
      appliedProgram: null,
      appliedPoNumber: null,
      appliedPoAmount: "50",
    },
  ],
  activity: [
    {
      kind: "cell_edit",
      at: "2026-05-21T00:30:00.000Z",
      summary: 'PO Number → "PO-42"',
      actor: "homyk@thewolfpack.agency",
      detail: { column: "PO Number", status: "succeeded" },
    },
  ],
};

beforeEach(() => mockFetchWithRefresh.mockReset());

describe("<CodeDossierView />", () => {
  it("renders the loading state first", async () => {
    /* Resolve never to keep us in the loading branch. */
    mockFetchWithRefresh.mockReturnValue(new Promise(() => undefined));
    render(<CodeDossierView code="WPA-1" />);
    expect(screen.getByTestId("dossier-loading")).toBeInTheDocument();
  });

  it("renders not-found branch on HTTP 404", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(mkRes({ error: "code_not_found" }, { ok: false, status: 404 }));
    render(<CodeDossierView code="UNKNOWN" />);
    await waitFor(() => expect(screen.getByTestId("dossier-not-found")).toBeInTheDocument());
    expect(screen.getByTestId("dossier-back-link")).toHaveAttribute("href", "/job-codes");
  });

  it("renders generic error chip on 5xx", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(mkRes({ error: "boom" }, { ok: false, status: 500 }));
    render(<CodeDossierView code="X" />);
    await waitFor(() => expect(screen.getByTestId("dossier-error")).toBeInTheDocument());
    expect(screen.getByTestId("dossier-error").textContent).toMatch(/boom/);
  });

  it("renders header, rollups, and receipts tab content on success", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(mkRes({ dossier: sampleDossier }));
    render(<CodeDossierView code="WPA-1" />);

    await waitFor(() => expect(screen.getByTestId("code-dossier")).toBeInTheDocument());
    expect(screen.getByTestId("dossier-code").textContent).toBe("WPA-1");
    expect(screen.getByTestId("dossier-description").textContent).toBe("Wolfpack Auto program");
    expect(screen.getByTestId("dossier-category").textContent).toMatch(/Wolfpack Auto/);
    expect(screen.getByTestId("dossier-program").textContent).toBe("Phase 2");
    expect(screen.getByTestId("dossier-po-number").textContent).toBe("PO-42");
    expect(screen.getByTestId("dossier-po-amount").textContent).toBe("$3,500.00");

    /* Rollup cards. */
    expect(screen.getByTestId("rollup-spend-ytd").textContent).toMatch(/\$150/);
    expect(screen.getByTestId("rollup-spend-mtd").textContent).toMatch(/\$50/);
    expect(screen.getByTestId("rollup-receipt-count").textContent).toMatch(/2/);

    /* Receipts tab is default. */
    expect(screen.getByTestId("receipts-table")).toBeInTheDocument();
    expect(screen.getByTestId("receipt-row-r-1")).toBeInTheDocument();
  });

  it("renders PO Remaining in red when spend exceeds PO Amount", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(mkRes({ dossier: sampleDossier }));
    render(<CodeDossierView code="WPA-1" />);
    await waitFor(() => expect(screen.getByTestId("rollup-po-remaining")).toBeInTheDocument());
    const remaining = screen.getByTestId("rollup-po-remaining");
    /* The value div is the second child; check its computed style. */
    const valueDiv = remaining.querySelector("div:last-child") as HTMLElement;
    expect(valueDiv.style.color).toMatch(/#f87171|rgb\(248,\s*113,\s*113\)/i);
  });

  it("clicking Activity tab swaps to the activity list", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(mkRes({ dossier: sampleDossier }));
    render(<CodeDossierView code="WPA-1" />);
    await waitFor(() => expect(screen.getByTestId("receipts-table")).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByTestId("tab-activity"));
    });
    expect(screen.getByTestId("activity-list")).toBeInTheDocument();
    expect(screen.getByTestId("activity-item-0").textContent).toMatch(/PO Number/);
    expect(screen.queryByTestId("receipts-table")).not.toBeInTheDocument();
  });

  it("receipts tab shows empty state when receipts list is empty", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(
      mkRes({ dossier: { ...sampleDossier, receipts: [], rollups: { ...sampleDossier.rollups, receiptCount: 0 } } }),
    );
    render(<CodeDossierView code="WPA-1" />);
    await waitFor(() => expect(screen.getByTestId("receipts-empty")).toBeInTheDocument());
  });
});
