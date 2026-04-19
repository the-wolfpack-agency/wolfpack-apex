/**
 * @jest-environment jsdom
 */

/**
 * FigmaImporter — UI tests.
 *
 * Mocks the global fetch used by `fetchWithRefresh`. Verifies the
 * disabled-submit guard, the preview card, the "Apply" wiring, the
 * error path, and the `figma_import_applied` analytics POST.
 */

import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import FigmaImporter from "@/components/sites/FigmaImporter";
import type { FigmaImportResult } from "@/lib/figma-import";

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

function sampleResult(): FigmaImportResult {
  return {
    ok: true,
    reason: "ok",
    scraped: {
      fileKey: "ACME123",
      fileName: "Acme Marketing",
      lastModified: "2026-04-19T00:00:00Z",
      topLevelFrames: [
        { id: "1:1", name: "Hero", type: "FRAME" },
        { id: "2:1", name: "Pricing", type: "FRAME" },
      ],
      colors: ["#ff8800", "#00ccaa", "#111111"],
      fonts: [{ family: "Inter", weights: [400, 700] }],
      suggestedBriefPages: [
        {
          route: "/hero",
          title: "Hero",
          frameId: "1:1",
          sectionHints: [{ type: "hero", heading: "Welcome" }],
        },
        {
          route: "/pricing",
          title: "Pricing",
          frameId: "2:1",
          sectionHints: [{ type: "pricing" }],
        },
      ],
      latencyMs: 250,
    },
    briefSuggestion: {
      theme: {
        colors: { primary: "#ff8800", accent: "#00ccaa" },
        font: { family: "Inter" },
      },
      pages: [
        {
          route: "/hero",
          title: "Hero",
          sections: [{ type: "hero", heading: "Welcome" }],
        },
      ],
    },
  };
}

describe("FigmaImporter", () => {
  test("submit is disabled with empty input", () => {
    render(<FigmaImporter onApply={() => {}} />);
    const btn = screen.getByTestId("figma-url-submit") as HTMLButtonElement;
    expect(btn).toBeDisabled();
  });

  test("submit becomes enabled once the user pastes a URL", () => {
    render(<FigmaImporter onApply={() => {}} />);
    const input = screen.getByTestId("figma-url-input") as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: "https://www.figma.com/file/ABC/slug" },
    });
    const btn = screen.getByTestId("figma-url-submit") as HTMLButtonElement;
    expect(btn).not.toBeDisabled();
  });

  test("clicking Import POSTs to /api/figma/import with the URL", async () => {
    fetchSpy.mockResolvedValueOnce(mkJson(200, sampleResult()));
    render(<FigmaImporter onApply={() => {}} />);
    const input = screen.getByTestId("figma-url-input") as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: "https://www.figma.com/file/ACME123/slug" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("figma-url-submit"));
    });
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const [firstCall] = fetchSpy.mock.calls;
    expect(firstCall[0]).toBe("/api/figma/import");
    const init = firstCall[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      url: "https://www.figma.com/file/ACME123/slug",
    });
  });

  test("renders preview card with file name, palette, and fonts on success", async () => {
    fetchSpy.mockResolvedValueOnce(mkJson(200, sampleResult()));
    render(<FigmaImporter onApply={() => {}} />);
    fireEvent.change(screen.getByTestId("figma-url-input"), {
      target: { value: "https://www.figma.com/file/ACME123/slug" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("figma-url-submit"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("figma-importer-preview")).toBeInTheDocument();
    });
    expect(screen.getByTestId("figma-importer-preview-file")).toHaveTextContent(
      "Acme Marketing",
    );
    expect(screen.getByTestId("figma-importer-palette")).toBeInTheDocument();
    expect(
      screen.getAllByTestId("figma-importer-swatch").length,
    ).toBeGreaterThan(0);
    expect(screen.getByTestId("figma-importer-preview-fonts")).toHaveTextContent(
      "Inter",
    );
  });

  test("Apply button calls onApply with briefSuggestion", async () => {
    fetchSpy.mockResolvedValueOnce(mkJson(200, sampleResult()));
    const onApply = jest.fn();
    render(<FigmaImporter onApply={onApply} siteId="site_123" />);
    fireEvent.change(screen.getByTestId("figma-url-input"), {
      target: { value: "https://www.figma.com/file/ACME123/slug" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("figma-url-submit"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("figma-importer-apply")).toBeInTheDocument(),
    );
    fetchSpy.mockResolvedValueOnce(mkJson(200, { ok: true }));
    await act(async () => {
      fireEvent.click(screen.getByTestId("figma-importer-apply"));
    });
    expect(onApply).toHaveBeenCalledTimes(1);
    const passed = onApply.mock.calls[0][0];
    expect(passed.theme.font.family).toBe("Inter");
    expect(passed.pages.length).toBe(1);
  });

  test("error response surfaces an error message", async () => {
    fetchSpy.mockResolvedValueOnce(
      mkJson(503, {
        ok: false,
        reason: "not_configured",
        scraped: null,
        briefSuggestion: null,
      } as FigmaImportResult),
    );
    render(<FigmaImporter onApply={() => {}} />);
    fireEvent.change(screen.getByTestId("figma-url-input"), {
      target: { value: "https://www.figma.com/file/ABC/slug" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("figma-url-submit"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("figma-importer-error")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("figma-importer-error")).toHaveTextContent(
      /FIGMA_ACCESS_TOKEN|configured/i,
    );
  });

  test("Apply POSTs figma_import_applied analytics with counts + file_key", async () => {
    fetchSpy.mockResolvedValueOnce(mkJson(200, sampleResult()));
    render(<FigmaImporter onApply={() => {}} siteId="site_abc" />);
    fireEvent.change(screen.getByTestId("figma-url-input"), {
      target: { value: "https://www.figma.com/file/ACME123/slug" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("figma-url-submit"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("figma-importer-apply")).toBeInTheDocument(),
    );
    fetchSpy.mockResolvedValueOnce(mkJson(200, { ok: true }));
    await act(async () => {
      fireEvent.click(screen.getByTestId("figma-importer-apply"));
    });
    const analyticsCall = fetchSpy.mock.calls.find(
      (c) => c[0] === "/api/analytics",
    );
    expect(analyticsCall).toBeDefined();
    const body = JSON.parse(String(analyticsCall![1].body));
    expect(body.event).toBe("figma_import_applied");
    expect(body.metadata.site_id).toBe("site_abc");
    expect(body.metadata.file_key).toBe("ACME123");
    expect(body.metadata.applied_pages_count).toBe(1);
    expect(body.metadata.applied_theme_fields).toBeGreaterThan(0);
  });

  test("Reset clears the preview so the designer can try another URL", async () => {
    fetchSpy.mockResolvedValueOnce(mkJson(200, sampleResult()));
    render(<FigmaImporter onApply={() => {}} />);
    fireEvent.change(screen.getByTestId("figma-url-input"), {
      target: { value: "https://www.figma.com/file/ACME123/slug" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("figma-url-submit"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("figma-importer-preview")).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("figma-importer-reset"));
    });
    expect(
      screen.queryByTestId("figma-importer-preview"),
    ).not.toBeInTheDocument();
  });
});
