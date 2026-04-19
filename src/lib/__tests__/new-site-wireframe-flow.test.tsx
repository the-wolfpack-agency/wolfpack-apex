/**
 * @jest-environment jsdom
 */

/**
 * /sites/new — wireframe drop → review → apply → create flow.
 *
 * We can't mount the real page component directly — Next's
 * `use(params: Promise)` + the (dashboard) auth guard pull in things
 * jsdom doesn't supply. Instead we mirror the state machine here
 * (same pattern as sites-hard-delete-flow.test.tsx +
 * sites-detail-poll-stability.test.tsx), including the dropzone
 * dispatch + parse-brief POST + review card integration.
 *
 * Covers:
 *   - Dropping a PNG calls POST /api/sites/parse-brief with the correct
 *     multipart body (file + clientSlug).
 *   - 200 vision response → WireframeExtractReview mounts with palette.
 *   - Apply merges the extracted brief into parent state.
 *   - 503 ai_not_configured → actionable error banner, no review card.
 *   - 415 bad MIME → error banner naming the supported formats.
 *   - Canceling mid-request (AbortController) clears the loading state.
 */

import "@testing-library/jest-dom";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";

import WireframeExtractReview, {
  type WireframeExtractPayload,
} from "@/components/sites/WireframeExtractReview";
import type { SiteBrief } from "@/lib/sites-schema";

// ---------------------------------------------------------------------------
// Harness — the /sites/new state machine for wireframe drops, minus the
// router + template picker we don't exercise in these tests.
// ---------------------------------------------------------------------------

function parseBriefErrorMessage(status: number, data: { error?: string; reason?: string }): string {
  if (status === 503 || data.reason === "ai_not_configured") {
    return (
      data.error ??
      "AI extraction isn't configured. An admin needs to set ANTHROPIC_API_KEY on this environment."
    );
  }
  if (status === 413) return data.error ?? "Image too large (10 MB max).";
  if (status === 415) {
    return data.error ?? "That file type isn't supported. Try PNG, JPG, WEBP, or PDF.";
  }
  return data.error ?? "Couldn't read that file.";
}

interface HarnessProps {
  initialSlug?: string;
  fetchImpl: typeof fetch;
  onApplied?: (brief: SiteBrief) => void;
}

function NewSiteWireframeHarness({ initialSlug, fetchImpl, onApplied }: HarnessProps) {
  const [clientSlug, setClientSlug] = useState(initialSlug ?? "");
  const [parsing, setParsing] = useState(false);
  const [wireframeReview, setWireframeReview] = useState<WireframeExtractPayload | null>(null);
  const [wireframeError, setWireframeError] = useState<string | null>(null);
  const [appliedBrief, setAppliedBrief] = useState<SiteBrief | null>(null);
  const parseAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (parseAbortRef.current) parseAbortRef.current.abort();
    };
  }, []);

  async function handleWireframeFile(file: File) {
    if (parseAbortRef.current) parseAbortRef.current.abort();
    const controller = new AbortController();
    parseAbortRef.current = controller;
    setParsing(true);
    setWireframeError(null);
    setWireframeReview(null);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("clientSlug", clientSlug || "new-site");
    try {
      const r = await fetchImpl("/api/sites/parse-brief", {
        method: "POST",
        body: fd,
        signal: controller.signal,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setWireframeError(parseBriefErrorMessage(r.status, data));
      } else {
        setWireframeReview({
          brief: data.brief,
          source: data.source,
          metadata: data.metadata ?? {},
        });
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setWireframeError((err as Error).message);
      }
    } finally {
      if (parseAbortRef.current === controller) parseAbortRef.current = null;
      setParsing(false);
    }
  }

  function cancelInFlight() {
    if (parseAbortRef.current) parseAbortRef.current.abort();
    parseAbortRef.current = null;
    setParsing(false);
  }

  return (
    <div>
      <input
        data-testid="new-site-slug"
        value={clientSlug}
        onChange={(e) => setClientSlug(e.target.value)}
      />
      <button
        data-testid="drop-png"
        onClick={() =>
          handleWireframeFile(new File(["png-bytes"], "wireframe.png", { type: "image/png" }))
        }
      >
        drop png
      </button>
      <button
        data-testid="drop-txt"
        onClick={() =>
          handleWireframeFile(new File(["nope"], "bad.txt", { type: "text/plain" }))
        }
      >
        drop txt
      </button>
      <button data-testid="cancel-in-flight" onClick={cancelInFlight}>
        cancel
      </button>

      {parsing && <div data-testid="wireframe-loading-indicator">Analyzing…</div>}
      {wireframeError && (
        <div data-testid="wireframe-error-banner" role="alert">
          {wireframeError}
        </div>
      )}
      {wireframeReview && (
        <WireframeExtractReview
          payload={wireframeReview}
          onApply={(merged) => {
            setAppliedBrief(merged.brief);
            setWireframeReview((prev) =>
              prev ? { ...prev, brief: { ...merged.brief } } : prev,
            );
            if (onApplied) onApplied(merged.brief);
          }}
          onDismiss={() => setWireframeReview(null)}
        />
      )}
      {appliedBrief && (
        <div data-testid="applied-brief-client">{appliedBrief.client}</div>
      )}
      {appliedBrief?.theme && "colors" in appliedBrief.theme && (
        <div data-testid="applied-brief-primary">
          {(appliedBrief.theme as { colors: { primary?: string } }).colors.primary ?? ""}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal fetch Response stand-in. The real `Response` global isn't
 * available in the default ts-jest jsdom environment (no undici polyfill),
 * so we hand-roll the surface our code reads: `ok`, `status`, `json()`.
 */
function jsonResponse(status: number, body: unknown): Response {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ "content-type": "application/json" }),
  } as unknown as Response;
}

function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response>): jest.Mock {
  return jest.fn((url: string, init: RequestInit = {}) => handler(url, init)) as unknown as jest.Mock;
}

const HAPPY_PAYLOAD = {
  brief: {
    client: "acme-co",
    product: { name: "Acme" },
    pages: [
      { route: "/", title: "Home", sections: [{ type: "hero", heading: "Hi" }] },
    ],
  },
  source: "vision",
  metadata: {
    extractedColors: ["#112233", "#445566", "#778899", "#aabbcc", "#ddeeff"],
    detectedFont: "Inter",
    confidence: 0.9,
    latencyMs: 8000,
    generationId: "gen_ok",
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("/sites/new — wireframe drop → review → apply flow", () => {
  it("drops a PNG and POSTs /api/sites/parse-brief with the file + slug multipart fields", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, HAPPY_PAYLOAD));
    render(<NewSiteWireframeHarness initialSlug="acme-co" fetchImpl={fetchImpl as unknown as typeof fetch} />);

    await act(async () => {
      screen.getByTestId("drop-png").click();
      await Promise.resolve();
    });

    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/sites/parse-brief");
    expect((init as RequestInit).method).toBe("POST");
    const fd = (init as RequestInit).body as FormData;
    expect(fd).toBeInstanceOf(FormData);
    expect(fd.get("clientSlug")).toBe("acme-co");
    const file = fd.get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).type).toBe("image/png");
    expect((file as File).name).toBe("wireframe.png");
  });

  it("200 response mounts the review card with extracted colors", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, HAPPY_PAYLOAD));
    render(<NewSiteWireframeHarness fetchImpl={fetchImpl as unknown as typeof fetch} />);

    await act(async () => {
      screen.getByTestId("drop-png").click();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getByTestId("wireframe-extract-review")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("wireframe-color-swatch-primary")).toHaveAttribute(
      "data-color",
      "#112233",
    );
    expect(screen.getByTestId("wireframe-color-swatch-accent")).toHaveAttribute(
      "data-color",
      "#445566",
    );
  });

  it("Apply merges the extracted brief into parent state", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, HAPPY_PAYLOAD));
    const onApplied = jest.fn();
    render(
      <NewSiteWireframeHarness
        fetchImpl={fetchImpl as unknown as typeof fetch}
        onApplied={onApplied}
      />,
    );

    await act(async () => {
      screen.getByTestId("drop-png").click();
      await Promise.resolve();
    });
    await waitFor(() => screen.getByTestId("wireframe-extract-review"));

    await act(async () => {
      screen.getByTestId("wireframe-apply-btn").click();
      await Promise.resolve();
    });

    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    expect(screen.getByTestId("applied-brief-client").textContent).toBe("acme-co");
    expect(screen.getByTestId("applied-brief-primary").textContent).toBe("#112233");
  });

  it("503 ai_not_configured surfaces the actionable admin-copy, no review card", async () => {
    const fetchImpl = mockFetch(async () =>
      jsonResponse(503, {
        error: "AI extraction isn't configured. An admin needs to set ANTHROPIC_API_KEY on this environment.",
        reason: "ai_not_configured",
      }),
    );
    render(<NewSiteWireframeHarness fetchImpl={fetchImpl as unknown as typeof fetch} />);

    await act(async () => {
      screen.getByTestId("drop-png").click();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId("wireframe-error-banner")).toBeInTheDocument());
    expect(screen.getByTestId("wireframe-error-banner").textContent).toMatch(/ANTHROPIC_API_KEY/);
    expect(screen.queryByTestId("wireframe-extract-review")).not.toBeInTheDocument();
  });

  it("415 bad MIME surfaces an error naming the supported formats", async () => {
    const fetchImpl = mockFetch(async () =>
      jsonResponse(415, {
        error: "That file type isn't supported. Try PNG, JPG, WEBP, or PDF.",
      }),
    );
    render(<NewSiteWireframeHarness fetchImpl={fetchImpl as unknown as typeof fetch} />);

    await act(async () => {
      screen.getByTestId("drop-txt").click();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId("wireframe-error-banner")).toBeInTheDocument());
    const banner = screen.getByTestId("wireframe-error-banner").textContent ?? "";
    expect(banner).toMatch(/PNG/);
    expect(banner).toMatch(/WEBP/);
    expect(banner).toMatch(/PDF/);
  });

  it("canceling mid-request clears the loading state (AbortController)", async () => {
    // Pending promise so we can observe the in-flight loading state.
    let resolveFetch: ((r: Response) => void) | null = null;
    const fetchImpl = jest.fn(
      (_url: string, init: RequestInit = {}) =>
        new Promise<Response>((resolve, reject) => {
          resolveFetch = resolve;
          // The harness passes signal — wire it so abort rejects the
          // pending promise with an AbortError, mirroring real fetch.
          const signal = init.signal;
          if (signal) {
            signal.addEventListener("abort", () => {
              const e = new Error("aborted");
              e.name = "AbortError";
              reject(e);
            });
          }
        }),
    );
    render(<NewSiteWireframeHarness fetchImpl={fetchImpl as unknown as typeof fetch} />);

    await act(async () => {
      screen.getByTestId("drop-png").click();
      await Promise.resolve();
    });
    expect(screen.getByTestId("wireframe-loading-indicator")).toBeInTheDocument();

    // User navigates away / cancels — harness aborts the in-flight fetch.
    await act(async () => {
      screen.getByTestId("cancel-in-flight").click();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.queryByTestId("wireframe-loading-indicator")).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId("wireframe-extract-review")).not.toBeInTheDocument();
    // No error banner either — the user chose to cancel.
    expect(screen.queryByTestId("wireframe-error-banner")).not.toBeInTheDocument();
    // Silence unused-var lint on the resolver — intentionally unused.
    void resolveFetch;
  });
});
