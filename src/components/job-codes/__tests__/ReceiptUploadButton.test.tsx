/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * Pins the receipt-upload flow end-to-end at the UI layer:
 *   1. Button hidden when caller can't edit.
 *   2. File picked → POST /api/job-codes/scan-receipt → fields surfaced.
 *   3. User picks a code + Apply → PATCH /cell per non-empty field
 *      + POST /apply to record the commit.
 *   4. Error paths surface to the chip without losing the upload.
 */

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
}));

import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ReceiptUploadButton } from "@/components/job-codes/ReceiptUploadButton";

function mkRes(body: unknown, opts: { ok?: boolean; status?: number } = {}): any {
  return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => body };
}

const codes = [
  { code: "WPA-1", description: "Acme dealer DOS", extra: { "Client/Category": "Acme" } },
  { code: "WPA-2", description: "Acme retainer", extra: { "Client/Category": "Acme" } },
  { code: "GLB-1", description: "Globex retainer", extra: { "Client/Category": "Globex" } },
];

beforeEach(() => mockFetchWithRefresh.mockReset());

describe("<ReceiptUploadButton />", () => {
  it("renders nothing when canEdit is false", () => {
    render(<ReceiptUploadButton canEdit={false} codeOptions={codes} />);
    expect(screen.queryByTestId("receipt-upload-trigger")).not.toBeInTheDocument();
  });

  it("opens modal, scans, shows fields, applies to chosen code", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkRes({
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
      })) // scan
      .mockResolvedValueOnce(mkRes({ ok: true, new_value: "PO-12" })) // PATCH E
      .mockResolvedValueOnce(mkRes({ ok: true, new_value: "124.5" })) // PATCH F
      .mockResolvedValueOnce(mkRes({ ok: true })) // apply
      .mockResolvedValue(mkRes({}));

    await act(async () => {
      render(<ReceiptUploadButton canEdit={true} codeOptions={codes} />);
    });

    /* Open file picker programmatically (hidden input). */
    const input = screen.getByTestId("receipt-upload-input") as HTMLInputElement;
    const fakeFile = new File([new Uint8Array([1, 2, 3])], "receipt.png", { type: "image/png" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [fakeFile] } });
    });

    /* Wait for the extracted summary to render. */
    await waitFor(() => expect(screen.getByTestId("receipt-extracted-summary")).toBeInTheDocument());
    expect(screen.getByTestId("receipt-extracted-summary")).toHaveTextContent("Acme Hardware");

    /* Cascading picker: pick category first (filters to Acme codes),
       then the code dropdown appears. */
    fireEvent.change(screen.getByTestId("receipt-category-picker"), { target: { value: "Acme" } });
    fireEvent.change(screen.getByTestId("receipt-code-picker"), { target: { value: "WPA-1" } });
    fireEvent.change(screen.getByTestId("receipt-field-po-number"), { target: { value: "PO-12" } });
    /* PO Amount was pre-filled from total (124.5). */
    expect((screen.getByTestId("receipt-field-po-amount") as HTMLInputElement).value).toBe("124.5");

    await act(async () => {
      fireEvent.click(screen.getByTestId("receipt-apply"));
    });

    /* Patches sent in batch (Promise.all) — both fired. */
    const patches = mockFetchWithRefresh.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("/api/job-codes/WPA-1/cell"),
    );
    expect(patches.length).toBe(2); // E + F (Program blank → skipped)
    const cols = patches.map((c) => JSON.parse((c[1] as { body: string }).body).column).sort();
    expect(cols).toEqual(["E", "F"]);

    /* Apply endpoint hit too. */
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

  it("Job Code dropdown is filtered by chosen Client/Category", async () => {
    /* Pins the 2026-05-21 UX request: scan-receipt picker must
       narrow Code options by Client/Category, not show all 37 codes
       in one flat list. */
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkRes({
        ok: true,
        scan_id: "scan-1",
        fields: {
          merchantName: "Acme", transactionDate: "2026-05-21", total: 124.5,
          subtotal: null, tax: null, currency: "USD", items: [],
          documentConfidence: 0.92, rawText: "",
        },
      }))
      .mockResolvedValue(mkRes({}));

    await act(async () => {
      render(<ReceiptUploadButton canEdit={true} codeOptions={codes} />);
    });
    const input = screen.getByTestId("receipt-upload-input") as HTMLInputElement;
    const file = new File([new Uint8Array([1])], "r.png", { type: "image/png" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await waitFor(() => expect(screen.getByTestId("receipt-category-picker")).toBeInTheDocument());

    /* Before category pick, code dropdown is not visible. */
    expect(screen.queryByTestId("receipt-code-picker")).not.toBeInTheDocument();

    /* Picking Acme shows the code dropdown with only Acme codes
       (WPA-1, WPA-2 — not GLB-1). */
    fireEvent.change(screen.getByTestId("receipt-category-picker"), { target: { value: "Acme" } });
    const codePicker = await screen.findByTestId("receipt-code-picker");
    const opts = Array.from(codePicker.querySelectorAll("option")).map((o) => o.getAttribute("value"));
    expect(opts).toEqual(expect.arrayContaining(["WPA-1", "WPA-2"]));
    expect(opts).not.toContain("GLB-1");
  });

  it("surfaces a scan error WITHOUT closing the modal", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(
      mkRes({ error: "not_configured", detail: "no key" }, { ok: false, status: 503 }),
    );
    await act(async () => {
      render(<ReceiptUploadButton canEdit={true} codeOptions={codes} />);
    });
    const input = screen.getByTestId("receipt-upload-input") as HTMLInputElement;
    const file = new File([new Uint8Array([1])], "r.png", { type: "image/png" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await waitFor(() => expect(screen.getByTestId("receipt-upload-error")).toBeInTheDocument());
    expect(screen.getByTestId("receipt-upload-error")).toHaveTextContent(/not_configured/);
  });
});
