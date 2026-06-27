/**
 * @jest-environment jsdom
 *
 * /docs page — empty-state and `?generate=1` deep-link consolidation.
 *
 * Covers:
 *   - Empty state advertises the three generators (API doc, release notes,
 *     feature doc) instead of a useless "no documents yet" blank slate.
 *   - Each generator card opens the generate form pre-typed for that flavor.
 *   - Empty state surfaces a link back to /knowledge for Q/A style notes.
 *   - `/docs?generate=1` (the deep-link from the Knowledge page CTA) opens
 *     the generate form on mount and strips the param from the URL.
 *   - `/docs` with no `generate` param does NOT auto-open the form.
 */

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...args: unknown[]) => mockFetchWithRefresh(...args),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
  authHeaders: () => ({}),
}));

beforeAll(() => {
  Object.defineProperty(window, "localStorage", {
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    writable: true,
  });
});

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockFetchWithRefresh.mockImplementation((url: string, init?: RequestInit) => {
    if (typeof url === "string" && url.startsWith("/api/docs") && (!init || !init.method || init.method === "GET")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ documents: [] }),
      } as unknown as Response);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true }),
    } as unknown as Response);
  });
});

async function renderPage() {
  const mod = await import("@/app/(dashboard)/docs/page");
  const Page = mod.default;
  await act(async () => {
    render(<Page />);
  });
}

function setLocation(href: string) {
  // jsdom's location is read-only at the property level; mutate via
  // the standard `history.pushState` so window.location.search picks
  // up the new value while keeping React/hooks intact (avoiding
  // jest.resetModules which would re-load React).
  const url = new URL(href);
  window.history.pushState({}, "", url.pathname + url.search);
}

test("Empty state lists the three generator cards and a link to /knowledge", async () => {
  // Default URL — no ?generate=1
  setLocation("http://localhost/docs");
  await renderPage();
  await waitFor(() => {
    expect(screen.getByTestId("docs-empty-state")).toBeInTheDocument();
  });
  expect(screen.getByTestId("docs-empty-card-api_doc")).toBeInTheDocument();
  expect(screen.getByTestId("docs-empty-card-release_notes")).toBeInTheDocument();
  expect(screen.getByTestId("docs-empty-card-feature_doc")).toBeInTheDocument();
  expect(screen.getByText(/Knowledge Base/)).toBeInTheDocument();
});

test("Clicking a generator card opens the generate form with that doc type pre-selected", async () => {
  setLocation("http://localhost/docs");
  await renderPage();
  await waitFor(() => {
    expect(screen.getByTestId("docs-empty-card-release_notes")).toBeInTheDocument();
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("docs-empty-card-release_notes"));
  });
  // The select for doc type should now be visible and set to release_notes
  const select = await screen.findByDisplayValue("Release Notes");
  expect(select).toBeInTheDocument();
});

test("`/docs?generate=1` is ignored (no URL-controlled auto-open) - secure-by-default", async () => {
  /* The `?generate=1` deep-link was removed in the CodeQL hardening pass
   * (7de8a1dc) - branching control flow on user-controlled URL input was
   * flagged as js/user-controlled-bypass. The Generate panel must NOT
   * auto-open from the URL; it is only reachable via the in-page button.
   * Re-adding the deep-link would re-open the security finding, so this
   * test locks the secure behaviour instead. */
  setLocation("http://localhost/docs?generate=1");
  await renderPage();
  await waitFor(() => {
    expect(screen.getByTestId("docs-empty-state")).toBeInTheDocument();
  });
  // The generate panel stays closed despite the URL param.
  expect(screen.queryByTestId("docs-generate-panel")).not.toBeInTheDocument();

  // It opens only via the explicit in-page control.
  await act(async () => {
    fireEvent.click(screen.getByTestId("docs-empty-card-release_notes"));
  });
  expect(screen.getByTestId("docs-generate-panel")).toBeInTheDocument();
});

test("`/docs` with no params does NOT auto-open the generate form", async () => {
  setLocation("http://localhost/docs");
  await renderPage();
  await waitFor(() => {
    expect(screen.getByTestId("docs-empty-state")).toBeInTheDocument();
  });
  // Generate panel is closed until the user clicks Generate or a card.
  expect(screen.queryByTestId("docs-generate-panel")).not.toBeInTheDocument();
});
