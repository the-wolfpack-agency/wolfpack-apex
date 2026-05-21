/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * ScanReceiptWidget — assistant-surface receipt scanner.
 *
 * Pins:
 *   1. Read-only callers see a permission stub, not the dropzone.
 *   2. File picked → POST /scan-receipt → fields surface inline.
 *   3. Apply → Promise.all of /cell PATCHes + /apply audit call,
 *      ONLY for non-empty fields (skipped fields → skipped PATCH).
 *   4. Scan error surfaces in the chip without killing the widget.
 */

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
}));

import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ScanReceiptWidget } from "@/components/widgets/ScanReceiptWidget";

function mkRes(body: unknown, opts: { ok?: boolean; status?: number } = {}): any {
  return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => body };
}

const spec = { kind: "scan_receipt" } as const;

beforeEach(() => mockFetchWithRefresh.mockReset());

describe("<ScanReceiptWidget />", () => {
  it("renders a permission stub for read-only callers", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkRes({ capabilities: ["jobcodes.view"] })) // no refresh
      .mockResolvedValueOnce(mkRes({})) // analytics
      .mockResolvedValueOnce(mkRes({ codes: [] }))
      .mockResolvedValue(mkRes({}));
    await act(async () => {
      render(<ScanReceiptWidget spec={spec} />);
    });
    /* Stub renders synchronously after the capability check resolves.
       Just wait for the widget to be in the document. */
    await waitFor(() => expect(screen.getByTestId("scan-receipt-widget")).toBeInTheDocument());
    expect(screen.queryByTestId("scan-receipt-trigger")).not.toBeInTheDocument();
    expect(screen.getByTestId("scan-receipt-widget")).toHaveTextContent(/admin role/i);
  });

  it("scans a file, shows fields, applies non-empty values, fires /apply", async () => {
    /* URL-based routing instead of sequential mocks — the widget fires
       analytics POSTs interleaved with the real work calls, so a
       strict sequence is fragile. */
    mockFetchWithRefresh.mockImplementation(async (url: string) => {
      if (url === "/api/me/capabilities") return mkRes({ capabilities: ["jobcodes.refresh"] });
      if (url === "/api/job-codes") return mkRes({ codes: [
        { code: "WPA-1", description: "Acme dealer" },
        { code: "GLB-1", description: "Globex" },
      ] });
      if (url === "/api/job-codes/scan-receipt") return mkRes({
        ok: true,
        scan_id: "scan-xyz",
        fields: {
          merchantName: "Acme Hardware",
          transactionDate: "2026-05-21",
          total: 124.5,
          subtotal: null,
          tax: null,
          currency: "USD",
          items: [],
          documentConfidence: 0.92,
          rawText: "",
        },
      });
      if (url.startsWith("/api/job-codes/WPA-1/cell")) return mkRes({ ok: true, new_value: "ok" });
      if (url.startsWith("/api/job-codes/scan-receipt/") && url.endsWith("/apply")) return mkRes({ ok: true });
      return mkRes({});
    });

    await act(async () => {
      render(<ScanReceiptWidget spec={spec} />);
    });
    /* Wait for capability + catalog to resolve so the trigger renders. */
    const trigger = await screen.findByTestId("scan-receipt-trigger");
    expect(trigger).toBeInTheDocument();

    /* Fire the file input directly (the hidden input proxies the click). */
    const input = screen.getByTestId("scan-receipt-input") as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], "r.png", { type: "image/png" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    await waitFor(() => expect(screen.getByTestId("scan-receipt-summary")).toBeInTheDocument());
    expect(screen.getByTestId("scan-receipt-summary")).toHaveTextContent("Acme Hardware");

    /* Pick code + set PO Number; leave Program empty (skipped); PO
       Amount auto-filled from total. */
    fireEvent.change(screen.getByTestId("scan-receipt-code"), { target: { value: "WPA-1" } });
    fireEvent.change(screen.getByTestId("scan-receipt-field-E"), { target: { value: "PO-12" } });
    expect((screen.getByTestId("scan-receipt-field-F") as HTMLInputElement).value).toBe("124.5");

    await act(async () => {
      fireEvent.click(screen.getByTestId("scan-receipt-apply"));
    });

    const patches = mockFetchWithRefresh.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("/api/job-codes/WPA-1/cell"),
    );
    expect(patches.length).toBe(2); // E + F only; D was blank
    const cols = patches.map((c) => JSON.parse((c[1] as { body: string }).body).column).sort();
    expect(cols).toEqual(["E", "F"]);

    const apply = mockFetchWithRefresh.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("/api/job-codes/scan-receipt/scan-xyz/apply"),
    );
    expect(apply).toBeDefined();
    const applyBody = JSON.parse((apply![1] as { body: string }).body);
    expect(applyBody).toEqual({
      code: "WPA-1",
      program: null,
      po_number: "PO-12",
      po_amount: "124.5",
    });
  });

  it("scan error surfaces in chip without killing the widget", async () => {
    mockFetchWithRefresh.mockImplementation(async (url: string) => {
      if (url === "/api/me/capabilities") return mkRes({ capabilities: ["jobcodes.refresh"] });
      if (url === "/api/job-codes") return mkRes({ codes: [] });
      if (url === "/api/job-codes/scan-receipt") return mkRes({ error: "rate_limited" }, { ok: false, status: 429 });
      return mkRes({});
    });
    await act(async () => {
      render(<ScanReceiptWidget spec={spec} />);
    });
    const input = await screen.findByTestId("scan-receipt-input") as HTMLInputElement;
    const file = new File([new Uint8Array([1])], "r.png", { type: "image/png" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await waitFor(() => expect(screen.getByTestId("scan-receipt-error")).toBeInTheDocument());
    expect(screen.getByTestId("scan-receipt-error")).toHaveTextContent(/rate_limited/);
    /* Trigger still there — user can retry without remounting. */
    expect(screen.getByTestId("scan-receipt-trigger")).toBeInTheDocument();
  });
});
