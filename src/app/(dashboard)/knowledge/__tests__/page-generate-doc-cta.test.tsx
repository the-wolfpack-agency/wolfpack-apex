/**
 * @jest-environment jsdom
 *
 * /knowledge — "Generate Document" CTA bridge to /docs.
 *
 * Knowledge stores Q/A entries; technical document generation lives on
 * /docs. The CTA hands off rather than duplicating the form. This test
 * locks in:
 *   - The CTA renders on the page header.
 *   - It points at `/docs?generate=1` (the docs deep-link entry point).
 *   - Clicking it fires the consolidated `knowledge.doc_generated`
 *     analytics event with `stage=cta_clicked` so the learning loop
 *     can attribute generations to the bridge entry.
 */

import "fake-indexeddb/auto";
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/lib/knowledge-capture-offline", () => ({
  saveKnowledgeEntryOffline: jest.fn().mockResolvedValue({
    status: "created", id: "x", queueId: null,
  }),
  updateKnowledgeEntryOffline: jest.fn().mockResolvedValue({
    status: "created", id: "x", queueId: null,
  }),
  deleteKnowledgeEntryOffline: jest.fn().mockResolvedValue({
    status: "deleted", id: "x", queueId: null,
  }),
}));

jest.mock("@/lib/knowledge-rag-offline", () => ({
  queryKnowledgeWithCache: jest.fn().mockResolvedValue({
    from_cache: false,
    answer: null,
    server_has_no_answer: true,
    sources: [],
  }),
  RagOfflineMissError: class RagOfflineMissError extends Error {},
}));

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetchWithRefresh(...a),
  authHeaders: () => ({ Authorization: "Bearer x" }),
  jsonHeaders: () => ({ "Content-Type": "application/json", Authorization: "Bearer x" }),
}));

const fetchMock = jest.fn();

beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
  Object.defineProperty(window, "localStorage", {
    value: {
      _store: { instinct_token: "t" } as Record<string, string>,
      getItem(this: { _store: Record<string, string> }, k: string) {
        return this._store[k] ?? null;
      },
      setItem() {},
      removeItem() {},
      clear() {},
    },
    writable: true,
  });
});

beforeEach(() => {
  fetchMock.mockReset();
  mockFetchWithRefresh.mockReset();
  fetchMock.mockImplementation(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ entries: [] }),
      text: () => Promise.resolve("{}"),
    } as unknown as Response),
  );
  mockFetchWithRefresh.mockImplementation(() =>
    Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response),
  );
});

async function importPage() {
  const mod = await import("@/app/(dashboard)/knowledge/page");
  return mod.default;
}

test("Knowledge page renders the Generate Document CTA pointing at /docs?generate=1", async () => {
  const Page = await importPage();
  await act(async () => {
    render(<Page />);
  });
  await waitFor(() => {
    expect(screen.getByTestId("knowledge-generate-doc-cta")).toBeInTheDocument();
  });
  const cta = screen.getByTestId("knowledge-generate-doc-cta") as HTMLAnchorElement;
  expect(cta.tagName).toBe("A");
  expect(cta.getAttribute("href")).toBe("/docs?generate=1");
  expect(cta.textContent).toContain("Generate Document");
});

test("Clicking the CTA fires knowledge.doc_generated analytics with stage=cta_clicked", async () => {
  const Page = await importPage();
  await act(async () => {
    render(<Page />);
  });
  await waitFor(() => {
    expect(screen.getByTestId("knowledge-generate-doc-cta")).toBeInTheDocument();
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("knowledge-generate-doc-cta"));
  });
  // The analytics POST should land on /api/analytics with the right body.
  const calls = mockFetchWithRefresh.mock.calls.filter(
    (c) => c[0] === "/api/analytics" && c[1]?.method === "POST",
  );
  const matched = calls.find((c) => {
    const body = JSON.parse((c[1] as RequestInit).body as string);
    return (
      body.event === "knowledge.doc_generated" &&
      body.metadata?.stage === "cta_clicked" &&
      body.metadata?.source === "knowledge_page"
    );
  });
  expect(matched).toBeDefined();
});
