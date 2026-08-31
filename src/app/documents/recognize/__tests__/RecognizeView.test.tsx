/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * RecognizeView — drives the full /documents/recognize surface.
 *
 * Pins:
 *   1. Idle state renders the hero drop zone.
 *   2. File above 3.5 MB inline-errors and NEVER calls the API.
 *   3. Successful upload renders ClassificationCard + ExtractedFieldsTable.
 *   4. PII-blocked response renders the explicit "blocked" message.
 *   5. API 500 renders an error state with a retry control.
 *   6. Reclassify PATCHes the API and updates the displayed type.
 *   7. "Scan another" returns to idle.
 *   8. Uses fetchWithRefresh, NEVER raw fetch.
 */

const mockFetchWithRefresh = jest.fn();
const mockGetInstinctToken = jest.fn<string | null, []>();

/* Mock client-auth so the view's fetchWithRefresh + getInstinctToken
   calls are intercepted. We also mock window.fetch to assert that
   nothing in the component reaches for raw fetch — a regression that
   would re-introduce the April 16 blank-dashboard incident pattern. */
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
  getInstinctToken: () => mockGetInstinctToken(),
}));

import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RecognizeView } from "../RecognizeView";
import type {
  RecognizedDocument,
  DocumentClassification,
  ExtractedField,
} from "@/lib/document-recognition/types";

/* ── helpers ───────────────────────────────────────────────────── */

function mkRes(
  body: unknown,
  opts: { ok?: boolean; status?: number } = {},
): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => body,
  };
}

function mkClassification(
  overrides: Partial<DocumentClassification> = {},
): DocumentClassification {
  return {
    type: "receipt",
    confidence: 0.92,
    alternates: [],
    rationale: "Header reads 'Receipt' with a total amount line.",
    model: "claude-3-haiku",
    latencyMs: 350,
    costCents: 0.1,
    ...overrides,
  };
}

function mkRecognized(
  overrides: Partial<RecognizedDocument> = {},
): RecognizedDocument {
  const fields: ExtractedField[] = [
    { name: "vendor", value: "Acme Hardware", confidence: 0.95 },
    { name: "total", value: "42.50", confidence: 0.9 },
    { name: "transaction_date", value: "2026-05-21", confidence: 0.85 },
  ];
  return {
    id: "rec_abc",
    workspaceId: "ws_1",
    userId: "u_1",
    sourceFile: {
      filename: "receipt.png",
      mime: "image/png",
      bytes: 12_345,
      sha256: "deadbeef",
    },
    classification: mkClassification(),
    extraction: {
      extractor: "azure_prebuilt_receipt",
      model: "prebuilt-receipt",
      fields,
      rawText: "raw",
      latencyMs: 600,
      costCents: 0,
    },
    piiBlocked: false,
    recognizedAt: new Date().toISOString(),
    ...overrides,
  };
}

function dropFile(zone: HTMLElement, file: File) {
  fireEvent.drop(zone, {
    dataTransfer: { files: [file], types: ["Files"] },
  });
}

/* ── setup ─────────────────────────────────────────────────────── */

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockGetInstinctToken.mockReset();
  /* Default: authed. Tests that exercise the redirect can override. */
  mockGetInstinctToken.mockReturnValue("test-token");
});

/* ── tests ─────────────────────────────────────────────────────── */

describe("<RecognizeView />", () => {
  it("renders the hero drop zone in the idle state", async () => {
    await act(async () => {
      render(<RecognizeView />);
    });
    expect(await screen.findByTestId("recognize-drop-zone")).toBeInTheDocument();
    expect(screen.getByTestId("recognize-drop-headline")).toHaveTextContent(
      /upload a document/i,
    );
  });

  it("rejects files > 3.5 MB inline and never calls the API", async () => {
    await act(async () => {
      render(<RecognizeView />);
    });
    const zone = await screen.findByTestId("recognize-drop-zone");

    /* 4 MB synthetic — Buffer of zeros is fine for size enforcement. */
    const bigBytes = new Uint8Array(4 * 1024 * 1024);
    const file = new File([bigBytes], "huge.png", { type: "image/png" });

    await act(async () => {
      dropFile(zone, file);
    });

    expect(
      await screen.findByTestId("recognize-size-error"),
    ).toHaveTextContent(/file too large/i);
    expect(mockFetchWithRefresh).not.toHaveBeenCalled();
  });

  it("renders ClassificationCard + ExtractedFieldsTable on success", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(mkRes(mkRecognized()));

    await act(async () => {
      render(<RecognizeView />);
    });
    const zone = await screen.findByTestId("recognize-drop-zone");

    const file = new File([new Uint8Array([1, 2, 3])], "r.png", {
      type: "image/png",
    });
    await act(async () => {
      dropFile(zone, file);
    });

    await waitFor(() =>
      expect(screen.getByTestId("classification-card")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("extracted-fields-table")).toBeInTheDocument();
    expect(screen.getByTestId("classification-type-label")).toHaveTextContent(
      "Receipt",
    );
    /* The highest-confidence row is the vendor field — confirms the
       data flowed from the API response through the table. */
    expect(
      screen.getByTestId("extracted-field-value-vendor"),
    ).toHaveTextContent("Acme Hardware");
  });

  it("renders a clear blocked message for piiBlocked responses", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(
      mkRes(mkRecognized({ piiBlocked: true, extraction: null })),
    );

    await act(async () => {
      render(<RecognizeView />);
    });
    const zone = await screen.findByTestId("recognize-drop-zone");
    const file = new File([new Uint8Array([1, 2, 3])], "id.png", {
      type: "image/png",
    });
    await act(async () => {
      dropFile(zone, file);
    });

    expect(
      await screen.findByTestId("recognize-pii-blocked"),
    ).toHaveTextContent(/blocked for sensitive content/i);
    /* No classification card OR fields when PII was blocked. */
    expect(screen.queryByTestId("classification-card")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("extracted-fields-table"),
    ).not.toBeInTheDocument();
  });

  it("renders an error state with retry on API 500", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(
      mkRes({ error: "vendor 5xx" }, { ok: false, status: 500 }),
    );

    await act(async () => {
      render(<RecognizeView />);
    });
    const zone = await screen.findByTestId("recognize-drop-zone");
    const file = new File([new Uint8Array([1])], "x.png", { type: "image/png" });
    await act(async () => {
      dropFile(zone, file);
    });

    expect(await screen.findByTestId("recognize-error")).toHaveTextContent(
      /vendor 5xx/,
    );
    expect(screen.getByTestId("recognize-retry")).toBeInTheDocument();

    /* Retry returns to the idle drop zone, ready for another file. */
    await act(async () => {
      fireEvent.click(screen.getByTestId("recognize-retry"));
    });
    expect(await screen.findByTestId("recognize-drop-zone")).toBeInTheDocument();
  });

  it("reclassify PATCHes the API and optimiztically updates the displayed type", async () => {
    const initial = mkRecognized({
      classification: mkClassification({ type: "receipt", confidence: 0.6 }),
    });
    mockFetchWithRefresh.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (url === "/api/documents/recognize" && init?.method === "POST") {
          return mkRes(initial);
        }
        if (
          url === `/api/documents/recognize/${initial.id}` &&
          init?.method === "PATCH"
        ) {
          return mkRes({ ok: true });
        }
        return mkRes({});
      },
    );

    await act(async () => {
      render(<RecognizeView />);
    });
    const zone = await screen.findByTestId("recognize-drop-zone");
    await act(async () => {
      dropFile(
        zone,
        new File([new Uint8Array([1])], "x.png", { type: "image/png" }),
      );
    });

    const select = (await screen.findByTestId(
      "classification-reclassify-select",
    )) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(select, { target: { value: "invoice" } });
    });

    /* Optimiztic — the type label flips immediately to "Invoice". */
    await waitFor(() =>
      expect(screen.getByTestId("classification-type-label")).toHaveTextContent(
        "Invoice",
      ),
    );

    const patchCalls = mockFetchWithRefresh.mock.calls.filter(
      (c) =>
        c[0] === `/api/documents/recognize/${initial.id}` &&
        (c[1] as { method?: string })?.method === "PATCH",
    );
    expect(patchCalls.length).toBe(1);
    const body = JSON.parse(
      (patchCalls[0][1] as { body: string }).body,
    );
    expect(body).toEqual({ user_corrected_type: "invoice" });
  });

  it("'Scan another' returns to the idle drop zone", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(mkRes(mkRecognized()));

    await act(async () => {
      render(<RecognizeView />);
    });
    const zone = await screen.findByTestId("recognize-drop-zone");
    await act(async () => {
      dropFile(
        zone,
        new File([new Uint8Array([1])], "x.png", { type: "image/png" }),
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId("classification-card")).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("recognize-scan-another"));
    });
    expect(await screen.findByTestId("recognize-drop-zone")).toBeInTheDocument();
    expect(screen.queryByTestId("classification-card")).not.toBeInTheDocument();
  });

  it("uses fetchWithRefresh, NEVER raw fetch", async () => {
    /* Spy on window.fetch to prove the component never bypasses the
       auth wrapper. fetchWithRefresh itself is mocked so it never
       reaches this stub. */
    const realFetch = global.fetch;
    const fetchSpy = jest.fn(async () => mkRes({}) as unknown as Response);
    global.fetch = fetchSpy as unknown as typeof fetch;
    try {
      mockFetchWithRefresh.mockResolvedValueOnce(mkRes(mkRecognized()));

      await act(async () => {
        render(<RecognizeView />);
      });
      const zone = await screen.findByTestId("recognize-drop-zone");
      await act(async () => {
        dropFile(
          zone,
          new File([new Uint8Array([1])], "x.png", { type: "image/png" }),
        );
      });

      await waitFor(() =>
        expect(screen.getByTestId("classification-card")).toBeInTheDocument(),
      );

      expect(mockFetchWithRefresh).toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      global.fetch = realFetch;
    }
  });

  it("does not render the main UI and consults getInstinctToken when no token (redirect path)", async () => {
    /* jsdom won't let us reliably reassign window.location and the
       direct .href assignment triggers a real jsdom navigation that
       can't be cleanly intercepted. We assert the BEHAVIORAL
       contract instead — same approach the /qr page test uses: with
       no token, the auth gate stays unchecked, nothing renders, and
       crucially no authed API call ever fires. The href assignment
       itself is exercised by the E2E spec. */
    mockGetInstinctToken.mockReturnValue(null);

    await act(async () => {
      render(<RecognizeView />);
    });

    await waitFor(() => {
      expect(mockGetInstinctToken).toHaveBeenCalled();
    });

    /* Pre-auth-check returns null — none of the post-auth UI renders. */
    expect(screen.queryByTestId("recognize-drop-zone")).not.toBeInTheDocument();
    expect(screen.queryByTestId("classification-card")).not.toBeInTheDocument();

    /* And no authed endpoint was ever hit. */
    expect(mockFetchWithRefresh).not.toHaveBeenCalled();
  });
});
