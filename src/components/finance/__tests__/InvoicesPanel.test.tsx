/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * InvoicesPanel — pins the hero drop zone behavior shipped 2026-05-21
 * so the page's primary call to action stays primary across redesigns:
 *
 *   1. Read-only callers see a "view only" hint, NOT the drop zone.
 *   2. Managers see the drop zone (rendered via <label htmlFor=...>),
 *      which natively triggers the hidden file input on click.
 *   3. Drag-over flips the visual state (data-attr so tests don't
 *      depend on exact color values).
 *   4. Dropping a file fires the upload POST exactly once.
 *   5. Status chips still render correctly under the drop zone.
 *   6. Upload spinner state ("Reading invoice…") locks the zone while
 *      the request is in flight.
 */

const mockFetchWithRefresh = jest.fn();
const mockRouterPush = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush, replace: jest.fn() }),
}));

import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InvoicesPanel } from "@/components/finance/InvoicesPanel";

function mkRes(body: unknown, opts: { ok?: boolean; status?: number } = {}): any {
  return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => body };
}

const emptyList = {
  invoices: [],
  count: 0,
  status: "pending",
  counts: { pending: 0, approved: 0, paid: 0, rejected: 0 },
};

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockRouterPush.mockReset();
});

describe("<InvoicesPanel /> — hero drop zone", () => {
  it("renders the view-only hint when caller lacks finance.invoices.manage", async () => {
    mockFetchWithRefresh.mockImplementation(async (url: string) => {
      if (url === "/api/me/capabilities") return mkRes({ capabilities: ["finance.invoices.view"] });
      if (url.startsWith("/api/finance/invoices")) return mkRes(emptyList);
      return mkRes({});
    });

    await act(async () => { render(<InvoicesPanel />); });

    await waitFor(() => expect(screen.getByTestId("invoice-upload-readonly")).toBeInTheDocument());
    expect(screen.queryByTestId("invoice-upload-trigger")).not.toBeInTheDocument();
    expect(screen.getByTestId("invoice-upload-readonly")).toHaveTextContent(/view only/i);
  });

  it("renders the hero drop zone for managers + the file input it labels", async () => {
    mockFetchWithRefresh.mockImplementation(async (url: string) => {
      if (url === "/api/me/capabilities") return mkRes({ capabilities: ["finance.invoices.manage"] });
      if (url.startsWith("/api/finance/invoices")) return mkRes(emptyList);
      return mkRes({});
    });

    await act(async () => { render(<InvoicesPanel />); });

    const trigger = await screen.findByTestId("invoice-upload-trigger");
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveTextContent(/upload an invoice/i);
    /* The drop zone is a <label htmlFor=…> tied to the hidden input
       — that's how clicking the zone opens the file picker without
       a separate onClick handler. */
    expect(trigger.tagName).toBe("LABEL");
    expect(trigger.getAttribute("for")).toBe("invoice-upload-input-el");
    expect(screen.getByTestId("invoice-upload-input")).toHaveAttribute("id", "invoice-upload-input-el");
  });

  it("dropping a file fires exactly one POST /api/finance/invoices with multipart", async () => {
    mockFetchWithRefresh.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/me/capabilities") return mkRes({ capabilities: ["finance.invoices.manage"] });
      if (url === "/api/finance/invoices" && init?.method === "POST") {
        return mkRes({ ok: true, invoice_id: "inv_1", status: "pending" });
      }
      if (url.startsWith("/api/finance/invoices")) return mkRes(emptyList);
      return mkRes({});
    });

    await act(async () => { render(<InvoicesPanel />); });
    const zone = await screen.findByTestId("invoice-upload-trigger");

    const file = new File([new Uint8Array([1, 2, 3])], "invoice.pdf", { type: "application/pdf" });
    await act(async () => {
      fireEvent.drop(zone, { dataTransfer: { files: [file], types: ["Files"] } });
    });

    const posts = mockFetchWithRefresh.mock.calls.filter(
      (c) => c[0] === "/api/finance/invoices" && (c[1] as { method?: string })?.method === "POST",
    );
    expect(posts.length).toBe(1);
    expect((posts[0][1] as { body: FormData }).body).toBeInstanceOf(FormData);
  });

  it("drag-over flips dashed border to gold (visual state via inline style)", async () => {
    mockFetchWithRefresh.mockImplementation(async (url: string) => {
      if (url === "/api/me/capabilities") return mkRes({ capabilities: ["finance.invoices.manage"] });
      if (url.startsWith("/api/finance/invoices")) return mkRes(emptyList);
      return mkRes({});
    });

    await act(async () => { render(<InvoicesPanel />); });
    const zone = await screen.findByTestId("invoice-upload-trigger");

    /* Before drag: heading text is the resting copy. */
    expect(zone).toHaveTextContent(/upload an invoice/i);

    await act(async () => {
      fireEvent.dragOver(zone, { dataTransfer: { types: ["Files"] } });
    });

    /* After drag-over the heading swaps to "Drop to upload" — using
       text as the assertion handle keeps the test independent of
       exact CSS color values which are easy to fiddle with. */
    expect(zone).toHaveTextContent(/drop to upload/i);
  });

  it("renders the spinner copy while uploading and locks pointer", async () => {
    /* Hold the POST response open so we can observe the loading state
       in a way React Testing Library can synchronously assert. */
    let resolveUpload!: (v: any) => void;
    const uploadPromise = new Promise<any>((r) => { resolveUpload = r; });

    mockFetchWithRefresh.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/me/capabilities") return mkRes({ capabilities: ["finance.invoices.manage"] });
      if (url === "/api/finance/invoices" && init?.method === "POST") return uploadPromise;
      if (url.startsWith("/api/finance/invoices")) return mkRes(emptyList);
      return mkRes({});
    });

    await act(async () => { render(<InvoicesPanel />); });
    const zone = await screen.findByTestId("invoice-upload-trigger");
    const file = new File([new Uint8Array([1])], "x.pdf", { type: "application/pdf" });

    await act(async () => {
      fireEvent.drop(zone, { dataTransfer: { files: [file], types: ["Files"] } });
    });

    await waitFor(() => expect(zone).toHaveTextContent(/reading invoice/i));
    expect(zone.getAttribute("style") ?? "").toMatch(/cursor:\s*wait/i);

    await act(async () => { resolveUpload(mkRes({ ok: true, invoice_id: "inv_2", status: "pending" })); });
  });

  it("status chips still render under the drop zone with workspace counts", async () => {
    mockFetchWithRefresh.mockImplementation(async (url: string) => {
      if (url === "/api/me/capabilities") return mkRes({ capabilities: ["finance.invoices.manage"] });
      if (url.startsWith("/api/finance/invoices")) {
        return mkRes({ ...emptyList, counts: { pending: 3, approved: 1, paid: 7, rejected: 2 } });
      }
      return mkRes({});
    });

    await act(async () => { render(<InvoicesPanel />); });

    await waitFor(() => expect(screen.getByTestId("invoice-status-chips")).toBeInTheDocument());
    expect(screen.getByTestId("invoice-status-chip-pending")).toHaveTextContent("Pending (3)");
    expect(screen.getByTestId("invoice-status-chip-approved")).toHaveTextContent("Approved (1)");
    expect(screen.getByTestId("invoice-status-chip-paid")).toHaveTextContent("Paid (7)");
    expect(screen.getByTestId("invoice-status-chip-rejected")).toHaveTextContent("Rejected (2)");
  });
});

/**
 * <InvoicesPanel /> — Invoice/Receipt intake router (2026-05-21).
 *
 * Pins the unified intake surface:
 *   1. Toggle defaults to Invoice; clicking Receipt swaps headline +
 *      microcopy and replaces the testid (invoice-upload-trigger →
 *      receipt-upload-trigger).
 *   2. Invoice drop → POST /api/finance/invoices, refresh table
 *      (unchanged from PR #98).
 *   3. Receipt drop → POST /api/job-codes/scan-receipt, router.push
 *      to /job-codes?pending_scan=<scan_id>.
 *   4. Receipt-mode error stays on the same page in the upload-
 *      message chip — that's the contract that lets the user retry.
 *   5. Analytics: system.scan_document_routed fires per route with
 *      { type, scan_id }.
 */
describe("<InvoicesPanel /> — Invoice/Receipt intake router", () => {
  it("defaults to Invoice mode; clicking Receipt swaps the hero copy + drop zone testid", async () => {
    mockFetchWithRefresh.mockImplementation(async (url: string) => {
      if (url === "/api/me/capabilities") return mkRes({ capabilities: ["finance.invoices.manage"] });
      if (url.startsWith("/api/finance/invoices")) return mkRes(emptyList);
      return mkRes({});
    });

    await act(async () => { render(<InvoicesPanel />); });
    await waitFor(() => expect(screen.getByTestId("scan-mode-toggle")).toBeInTheDocument());

    expect(screen.getByTestId("scan-mode-invoice")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("invoice-upload-trigger")).toBeInTheDocument();
    expect(screen.queryByTestId("receipt-upload-trigger")).not.toBeInTheDocument();
    expect(screen.getByTestId("scan-drop-headline")).toHaveTextContent(/upload an invoice/i);
    expect(screen.getByTestId("scan-drop-microcopy")).toHaveTextContent(/vendor, amount/i);

    await act(async () => { fireEvent.click(screen.getByTestId("scan-mode-receipt")); });
    expect(screen.getByTestId("scan-mode-receipt")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("receipt-upload-trigger")).toBeInTheDocument();
    expect(screen.queryByTestId("invoice-upload-trigger")).not.toBeInTheDocument();
    expect(screen.getByTestId("scan-drop-headline")).toHaveTextContent(/upload a receipt/i);
    expect(screen.getByTestId("scan-drop-microcopy")).toHaveTextContent(/merchant.*allocate/i);
  });

  it("Invoice mode drop POSTs /api/finance/invoices and does NOT navigate", async () => {
    mockFetchWithRefresh.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/me/capabilities") return mkRes({ capabilities: ["finance.invoices.manage"] });
      if (url === "/api/finance/invoices" && init?.method === "POST") {
        return mkRes({ ok: true, invoice_id: "inv-1", cached: false, status: "pending" });
      }
      if (url.startsWith("/api/finance/invoices")) return mkRes(emptyList);
      return mkRes({});
    });

    await act(async () => { render(<InvoicesPanel />); });
    const zone = await screen.findByTestId("invoice-upload-trigger");

    const file = new File([new Uint8Array([1, 2, 3])], "invoice.pdf", { type: "application/pdf" });
    await act(async () => {
      fireEvent.drop(zone, { dataTransfer: { files: [file], types: ["Files"] } });
    });

    const invoicePost = mockFetchWithRefresh.mock.calls.find(
      (c) => c[0] === "/api/finance/invoices" && (c[1] as { method?: string })?.method === "POST",
    );
    expect(invoicePost).toBeDefined();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("Receipt mode drop POSTs /api/job-codes/scan-receipt then router.pushes /job-codes?pending_scan=<id>", async () => {
    mockFetchWithRefresh.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/me/capabilities") return mkRes({ capabilities: ["finance.invoices.manage"] });
      if (url === "/api/job-codes/scan-receipt" && init?.method === "POST") {
        return mkRes({
          ok: true,
          scan_id: "scan-789",
          fields: {
            merchantName: "Acme", transactionDate: "2026-05-21", total: 12.5,
            subtotal: null, tax: null, currency: "USD", items: [],
            documentConfidence: 0.9, rawText: "",
          },
        });
      }
      if (url.startsWith("/api/finance/invoices")) return mkRes(emptyList);
      return mkRes({});
    });

    await act(async () => { render(<InvoicesPanel />); });
    await act(async () => { fireEvent.click(screen.getByTestId("scan-mode-receipt")); });
    const zone = await screen.findByTestId("receipt-upload-trigger");
    const file = new File([new Uint8Array([1])], "receipt.png", { type: "image/png" });
    await act(async () => {
      fireEvent.drop(zone, { dataTransfer: { files: [file], types: ["Files"] } });
    });

    await waitFor(() => expect(mockRouterPush).toHaveBeenCalledTimes(1));
    expect(mockRouterPush).toHaveBeenCalledWith("/job-codes?pending_scan=scan-789");

    /* Did NOT POST to /api/finance/invoices in receipt mode. */
    const wrongPost = mockFetchWithRefresh.mock.calls.find(
      (c) => c[0] === "/api/finance/invoices" && (c[1] as { method?: string })?.method === "POST",
    );
    expect(wrongPost).toBeUndefined();
  });

  it("Receipt mode scan failure surfaces in the upload-message chip WITHOUT navigating", async () => {
    mockFetchWithRefresh.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/me/capabilities") return mkRes({ capabilities: ["finance.invoices.manage"] });
      if (url === "/api/job-codes/scan-receipt" && init?.method === "POST") {
        return mkRes({ error: "not_configured", detail: "AZURE not set" }, { ok: false, status: 503 });
      }
      if (url.startsWith("/api/finance/invoices")) return mkRes(emptyList);
      return mkRes({});
    });

    await act(async () => { render(<InvoicesPanel />); });
    await act(async () => { fireEvent.click(screen.getByTestId("scan-mode-receipt")); });
    const zone = await screen.findByTestId("receipt-upload-trigger");
    const file = new File([new Uint8Array([1])], "r.png", { type: "image/png" });
    await act(async () => {
      fireEvent.drop(zone, { dataTransfer: { files: [file], types: ["Files"] } });
    });

    await waitFor(() => expect(screen.getByTestId("invoice-upload-message")).toHaveTextContent(/Receipt scan failed/));
    expect(screen.getByTestId("invoice-upload-message")).toHaveTextContent(/not_configured/);
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("emits system.scan_document_routed analytics on each successful route", async () => {
    mockFetchWithRefresh.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/me/capabilities") return mkRes({ capabilities: ["finance.invoices.manage"] });
      if (url === "/api/finance/invoices" && init?.method === "POST") {
        return mkRes({ ok: true, invoice_id: "inv-77", cached: false, status: "pending" });
      }
      if (url === "/api/job-codes/scan-receipt" && init?.method === "POST") {
        return mkRes({
          ok: true,
          scan_id: "scan-99",
          fields: { merchantName: "X", transactionDate: null, total: 1, subtotal: null, tax: null, currency: null, items: [], documentConfidence: 1, rawText: "" },
        });
      }
      if (url.startsWith("/api/finance/invoices")) return mkRes(emptyList);
      return mkRes({});
    });

    await act(async () => { render(<InvoicesPanel />); });
    const invoiceZone = await screen.findByTestId("invoice-upload-trigger");

    /* Invoice route. */
    await act(async () => {
      fireEvent.drop(invoiceZone, { dataTransfer: { files: [new File([new Uint8Array([1])], "i.pdf", { type: "application/pdf" })], types: ["Files"] } });
    });

    /* Receipt route. */
    await act(async () => { fireEvent.click(screen.getByTestId("scan-mode-receipt")); });
    const receiptZone = await screen.findByTestId("receipt-upload-trigger");
    await act(async () => {
      fireEvent.drop(receiptZone, { dataTransfer: { files: [new File([new Uint8Array([1])], "r.png", { type: "image/png" })], types: ["Files"] } });
    });

    await waitFor(() => {
      const analyticsCalls = mockFetchWithRefresh.mock.calls.filter(
        (c) =>
          c[0] === "/api/analytics" &&
          typeof (c[1] as { body?: string })?.body === "string" &&
          (c[1] as { body: string }).body.includes("scan_document_routed"),
      );
      expect(analyticsCalls.length).toBeGreaterThanOrEqual(2);
      const bodies = analyticsCalls.map((c) => JSON.parse((c[1] as { body: string }).body));
      expect(bodies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "system.scan_document_routed", metadata: { type: "invoice", scan_id: "inv-77" } }),
          expect.objectContaining({ event: "system.scan_document_routed", metadata: { type: "receipt", scan_id: "scan-99" } }),
        ]),
      );
    });
  });
});
