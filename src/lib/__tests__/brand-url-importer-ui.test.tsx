/**
 * @jest-environment jsdom
 */

/**
 * BrandUrlImporter — UI tests.
 *
 * Mocks the global fetch used by `fetchWithRefresh`. Verifies the
 * disabled-submit guard, the scraped-preview card, the "Apply" wiring,
 * the error path, and the `brand_import_applied` analytics POST.
 */

import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import BrandUrlImporter from "@/components/sites/BrandUrlImporter";
import type { BrandImportResult } from "@/lib/brand-url-import";

let fetchSpy: jest.Mock;

beforeEach(() => {
  fetchSpy = jest.fn();
  (global as unknown as { fetch: typeof fetch }).fetch =
    fetchSpy as unknown as typeof fetch;
  window.localStorage.setItem("instinct_token", "test-token");
});

afterEach(() => {
  window.localStorage.clear();
  jest.restoreAllMocks();
});

function mkJson(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ "content-type": "application/json" }),
  } as unknown as Response;
}

function sampleResult(): BrandImportResult {
  return {
    ok: true,
    reason: "ok",
    scraped: {
      url: "https://example.com/",
      title: "Example Co",
      description: "Example description",
      ogImage: "https://example.com/og.png",
      faviconUrl: "https://example.com/favicon.ico",
      themeColor: "#112233",
      cssPalette: ["#ff0000", "#00ff00"],
      imagePalette: [],
      fontFamilies: ["Inter"],
      latencyMs: 123,
    },
    themeSuggestion: {
      colors: { primary: "#ff0000", accent: "#00ff00" },
      font: { family: "Inter" },
    },
  };
}

describe("BrandUrlImporter", () => {
  test("submit is disabled with empty input", () => {
    render(<BrandUrlImporter onApply={() => {}} />);
    const btn = screen.getByTestId("brand-url-submit") as HTMLButtonElement;
    expect(btn).toBeDisabled();
  });

  test("submit becomes enabled once the user types a URL", () => {
    render(<BrandUrlImporter onApply={() => {}} />);
    const input = screen.getByTestId("brand-url-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://example.com" } });
    const btn = screen.getByTestId("brand-url-submit") as HTMLButtonElement;
    expect(btn).not.toBeDisabled();
  });

  test("clicking Import POSTs to /api/brand/scrape with the URL", async () => {
    fetchSpy.mockResolvedValueOnce(mkJson(200, sampleResult()));
    render(<BrandUrlImporter onApply={() => {}} />);
    const input = screen.getByTestId("brand-url-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://example.com/" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("brand-url-submit"));
    });
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const [firstCall] = fetchSpy.mock.calls;
    expect(firstCall[0]).toBe("/api/brand/scrape");
    const init = firstCall[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      url: "https://example.com/",
    });
  });

  test("renders preview card with palette + font sample on success", async () => {
    fetchSpy.mockResolvedValueOnce(mkJson(200, sampleResult()));
    render(<BrandUrlImporter onApply={() => {}} />);
    fireEvent.change(screen.getByTestId("brand-url-input"), {
      target: { value: "https://example.com" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("brand-url-submit"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("brand-url-preview")).toBeInTheDocument();
    });
    expect(screen.getByTestId("brand-url-preview-title")).toHaveTextContent(
      "Example Co",
    );
    expect(screen.getByTestId("brand-url-palette")).toBeInTheDocument();
    expect(screen.getAllByTestId("brand-url-swatch").length).toBeGreaterThan(0);
    expect(screen.getByTestId("brand-url-preview-font")).toHaveTextContent(
      "Inter",
    );
  });

  test("Apply button calls onApply with the suggestion", async () => {
    fetchSpy.mockResolvedValueOnce(mkJson(200, sampleResult()));
    const onApply = jest.fn();
    render(<BrandUrlImporter onApply={onApply} siteId="site_123" />);
    fireEvent.change(screen.getByTestId("brand-url-input"), {
      target: { value: "https://example.com" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("brand-url-submit"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("brand-url-apply")).toBeInTheDocument();
    });
    // The analytics POST is the second fetch; prep its response.
    fetchSpy.mockResolvedValueOnce(mkJson(200, { ok: true }));
    await act(async () => {
      fireEvent.click(screen.getByTestId("brand-url-apply"));
    });
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toEqual({
      colors: { primary: "#ff0000", accent: "#00ff00" },
      font: { family: "Inter" },
    });
  });

  test("error path shows message when the API returns a failure", async () => {
    fetchSpy.mockResolvedValueOnce(
      mkJson(200, {
        ok: false,
        reason: "empty_result",
        scraped: null,
        themeSuggestion: null,
      } as BrandImportResult),
    );
    render(<BrandUrlImporter onApply={() => {}} />);
    fireEvent.change(screen.getByTestId("brand-url-input"), {
      target: { value: "https://empty.example" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("brand-url-submit"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("brand-url-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("brand-url-error")).toHaveTextContent(
      /brand-like/i,
    );
  });

  test("Apply POSTs brand_import_applied analytics with applied_fields", async () => {
    fetchSpy.mockResolvedValueOnce(mkJson(200, sampleResult()));
    render(<BrandUrlImporter onApply={() => {}} siteId="site_abc" />);
    fireEvent.change(screen.getByTestId("brand-url-input"), {
      target: { value: "https://example.com/" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("brand-url-submit"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("brand-url-apply")).toBeInTheDocument(),
    );
    // Analytics response
    fetchSpy.mockResolvedValueOnce(mkJson(200, { ok: true }));
    await act(async () => {
      fireEvent.click(screen.getByTestId("brand-url-apply"));
    });
    // The analytics POST is the second fetch — find it.
    const analyticsCall = fetchSpy.mock.calls.find(
      (c) => c[0] === "/api/analytics",
    );
    expect(analyticsCall).toBeDefined();
    const body = JSON.parse(String(analyticsCall![1].body));
    expect(body.event).toBe("brand_import_applied");
    expect(body.metadata.site_id).toBe("site_abc");
    expect(body.metadata.applied_fields).toContain("colors.primary");
    expect(body.metadata.applied_fields).toContain("font.family");
    expect(body.metadata.url_host).toBe("example.com");
  });

  test("Try-another-URL resets the preview so the designer can retry", async () => {
    fetchSpy.mockResolvedValueOnce(mkJson(200, sampleResult()));
    render(<BrandUrlImporter onApply={() => {}} />);
    fireEvent.change(screen.getByTestId("brand-url-input"), {
      target: { value: "https://example.com/" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("brand-url-submit"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("brand-url-preview")).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("brand-url-reset"));
    });
    expect(screen.queryByTestId("brand-url-preview")).not.toBeInTheDocument();
  });
});
