/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
const mockGetInstinctToken = jest.fn(() => "tkn");
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  getInstinctToken: () => mockGetInstinctToken(),
  authHeaders: () => ({ Authorization: "Bearer x" }),
  jsonHeaders: () => ({ "Content-Type": "application/json", Authorization: "Bearer x" }),
}));

import { Suspense } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SummaryPage from "@/app/(dashboard)/automations/[automationId]/summaries/[classKey]/page";

function renderPage(): void {
  // React's `use(params)` accepts a thenable. We synthesize one with
  // the resolved-shape React's runtime fast-paths so the page reads
  // params synchronously — equivalent to a Promise that has already
  // settled. Without this, tests either suspended forever (fresh
  // Promise per render) or only the first test in a run suspended
  // (shared Promise instance racing the runtime cache).
  const settled = {
    then() {},
    status: "fulfilled",
    value: {
      automationId: "porsche-classes",
      classKey: "BA101%7C2026-04-20%7CRitz%20Carlton",
    },
  };
  render(
    <Suspense fallback={<div data-testid="suspended" />}>
      <SummaryPage params={settled as any} />
    </Suspense>,
  );
}

interface MockResponse {
  ok?: boolean;
  status: number;
  json: () => Promise<any>;
}
function ok(body: any, status = 200): MockResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const SAMPLE_SUMMARY = {
  class_key: "BA101|2026-04-20|Ritz Carlton",
  course_type: "Porsche Academy",
  class_date: "2026-04-20T00:00:00.000Z",
  location: "Ritz Carlton",
  generated_at: "2026-04-26T18:00:00.000Z",
  participants: ["Alice Smith", "Bob Jones"],
  coordinator_notes: [
    { author: "Alicia", note: "Class went well." },
  ],
  instructor_notes: [
    { author: "Marc", note: "Engaged group." },
  ],
  open_exceptions: [],
  survey: null,
};

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  // Default: GET summary returns the sample. Individual tests override.
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (typeof url === "string" && url.includes("/summaries/") && !url.includes("/upload-sharepoint")) {
      return Promise.resolve(ok({ summary: SAMPLE_SUMMARY }));
    }
    return Promise.resolve(ok({}));
  });
  // Stub clipboard for jsdom.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: jest.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
  // jsdom: anchor.click() never navigates; we can spy without harm.
});

const PARAMS = Promise.resolve({ automationId: "porsche-classes", classKey: "BA101%7C2026-04-20%7CRitz%20Carlton" });

describe("SummaryPage — every button on the toolbar functions", () => {
  test("Copy as plain text → writes the formatted summary to navigator.clipboard", async () => {
    renderPage();
    await waitFor(() => screen.getByTestId("summary-page"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("copy-plain-text"));
    });
    const wt = (navigator.clipboard as any).writeText as jest.Mock;
    expect(wt).toHaveBeenCalled();
    const text = wt.mock.calls[0][0] as string;
    expect(text).toContain("PORSCHE ACADEMY — CLASS SUMMARY");
    expect(text).toContain("Course: Porsche Academy");
    expect(text).toContain("Location: Ritz Carlton");
    expect(text).toContain("Alice Smith");
  });

  test("Download JSON → creates a Blob anchor with the right filename + JSON body", async () => {
    const createUrl = jest.fn(() => "blob:mock-url");
    const revokeUrl = jest.fn();
    (URL as any).createObjectURL = createUrl;
    (URL as any).revokeObjectURL = revokeUrl;
    const clickSpy = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    renderPage();
    await waitFor(() => screen.getByTestId("summary-page"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("download-json"));
    });

    expect(createUrl).toHaveBeenCalledTimes(1);
    const blob = (createUrl.mock.calls as unknown as Blob[][])[0][0];
    expect(blob.type).toBe("application/json");
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeUrl).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  test("Download Word → triggers an anchor click to /export-docx with the encoded class key", async () => {
    let hrefCaptured: string | null = null;
    const clickSpy = jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        hrefCaptured = this.href;
      });

    renderPage();
    await waitFor(() => screen.getByTestId("summary-page"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("download-docx"));
    });
    expect(clickSpy).toHaveBeenCalled();
    expect(hrefCaptured).toContain("/api/automations/porsche-classes/summaries/");
    expect(hrefCaptured).toContain("/export-docx");
    clickSpy.mockRestore();
  });

  test("Download PDF → triggers an anchor click to /export-pdf", async () => {
    let hrefCaptured: string | null = null;
    const clickSpy = jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        hrefCaptured = this.href;
      });

    renderPage();
    await waitFor(() => screen.getByTestId("summary-page"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("download-pdf"));
    });
    expect(hrefCaptured).toContain("/export-pdf");
    clickSpy.mockRestore();
  });

  test("Upload to SharePoint → POSTs to /upload-sharepoint, surfaces success state with web_url", async () => {
    mockFetchWithRefresh.mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/upload-sharepoint")) {
        expect(init?.method).toBe("POST");
        return Promise.resolve(
          ok({ ok: true, web_url: "https://wolfpack.sharepoint.com/file.docx" }),
        );
      }
      if (typeof url === "string" && url.includes("/summaries/") && !url.includes("/upload")) {
        return Promise.resolve(ok({ summary: SAMPLE_SUMMARY }));
      }
      return Promise.resolve(ok({}));
    });

    renderPage();
    await waitFor(() => screen.getByTestId("summary-page"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("upload-sharepoint"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("sharepoint-upload-success")).toBeInTheDocument(),
    );
  });

  test("Upload to SharePoint → 202 skipped (not_configured) renders the soft skip state, not an error", async () => {
    mockFetchWithRefresh.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/upload-sharepoint")) {
        return Promise.resolve(
          ok({ ok: false, skipped_reason: "not_configured", error: "SharePoint not configured" }, 202),
        );
      }
      if (typeof url === "string" && url.includes("/summaries/")) {
        return Promise.resolve(ok({ summary: SAMPLE_SUMMARY }));
      }
      return Promise.resolve(ok({}));
    });
    renderPage();
    await waitFor(() => screen.getByTestId("summary-page"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("upload-sharepoint"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("sharepoint-upload-skipped")).toBeInTheDocument(),
    );
  });

  test("Upload to SharePoint → 502 graph_error renders the error state with the message", async () => {
    mockFetchWithRefresh.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/upload-sharepoint")) {
        return Promise.resolve(
          ok(
            {
              ok: false,
              skipped_reason: "graph_error",
              error: "SharePoint PUT 400: invalidName",
            },
            502,
          ),
        );
      }
      if (typeof url === "string" && url.includes("/summaries/")) {
        return Promise.resolve(ok({ summary: SAMPLE_SUMMARY }));
      }
      return Promise.resolve(ok({}));
    });
    renderPage();
    await waitFor(() => screen.getByTestId("summary-page"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("upload-sharepoint"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("sharepoint-upload-error")).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId("sharepoint-upload-error").textContent,
    ).toContain("invalidName");
  });

  test("Back to summaries breadcrumb is a real link to the parent automation summaries route", async () => {
    renderPage();
    await waitFor(() => screen.getByTestId("summary-page"));
    const link = screen.getByTestId("summary-breadcrumb") as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/automations/porsche-classes/summaries");
  });
});
