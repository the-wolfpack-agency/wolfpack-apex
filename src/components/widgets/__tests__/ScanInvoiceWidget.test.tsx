/** @jest-environment jsdom */

import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
}));

import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ScanInvoiceWidget } from "@/components/widgets/ScanInvoiceWidget";

const mk = (body: unknown, opts: { ok?: boolean; status?: number } = {}): any => ({
  ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => body,
});

const spec = { kind: "scan_invoice" } as const;

beforeEach(() => mockFetchWithRefresh.mockReset());

describe("<ScanInvoiceWidget />", () => {
  it("shows a permission stub for callers without finance.invoices.manage", async () => {
    mockFetchWithRefresh.mockImplementation(async (url: string) => {
      if (url === "/api/me/capabilities") return mk({ capabilities: ["finance.invoices.view"] });
      return mk({});
    });
    await act(async () => {
      render(<ScanInvoiceWidget spec={spec} />);
    });
    await waitFor(() => expect(screen.getByTestId("scan-invoice-widget")).toBeInTheDocument());
    expect(screen.queryByTestId("scan-invoice-trigger")).not.toBeInTheDocument();
    expect(screen.getByTestId("scan-invoice-widget")).toHaveTextContent(/finance.invoices.manage/i);
  });

  it("uploads, surfaces fields, links to /finance/invoices", async () => {
    mockFetchWithRefresh.mockImplementation(async (url: string) => {
      if (url === "/api/me/capabilities") return mk({ capabilities: ["finance.invoices.manage"] });
      if (url === "/api/finance/invoices") return mk({
        ok: true, invoice_id: "inv-1", cached: false,
        fields: {
          vendorName: "Acme", invoiceId: "INV-1", invoiceDate: "2026-05-15",
          dueDate: "2026-06-15", invoiceTotal: 1080, currency: "USD",
          lineItems: [{ description: "x", amount: 100 }], documentConfidence: 0.95,
        },
      });
      return mk({});
    });
    await act(async () => {
      render(<ScanInvoiceWidget spec={spec} />);
    });
    const input = await screen.findByTestId("scan-invoice-input") as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], "i.pdf", { type: "application/pdf" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await waitFor(() => expect(screen.getByTestId("scan-invoice-summary")).toBeInTheDocument());
    expect(screen.getByTestId("scan-invoice-summary")).toHaveTextContent("Acme");
    expect(screen.getByTestId("scan-invoice-open-queue")).toHaveAttribute("href", "/finance/invoices");
  });

  it("surfaces upload error in chip", async () => {
    mockFetchWithRefresh.mockImplementation(async (url: string) => {
      if (url === "/api/me/capabilities") return mk({ capabilities: ["finance.invoices.manage"] });
      if (url === "/api/finance/invoices") return mk({ error: "not_configured" }, { ok: false, status: 503 });
      return mk({});
    });
    await act(async () => {
      render(<ScanInvoiceWidget spec={spec} />);
    });
    const input = await screen.findByTestId("scan-invoice-input") as HTMLInputElement;
    const file = new File([new Uint8Array([1])], "i.pdf", { type: "application/pdf" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await waitFor(() => expect(screen.getByTestId("scan-invoice-error")).toBeInTheDocument());
    expect(screen.getByTestId("scan-invoice-error")).toHaveTextContent(/not_configured/);
  });
});
