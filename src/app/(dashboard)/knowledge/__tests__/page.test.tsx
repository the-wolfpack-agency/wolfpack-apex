/**
 * @jest-environment jsdom
 *
 * /knowledge page — Stream U2 integration. Verifies the RagSnapshotBadge
 * renders when an offline query resolves from U1's cache.
 */

import "fake-indexeddb/auto";
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
  fetchMock.mockImplementation(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ entries: [] }),
      text: () => Promise.resolve("{}"),
    } as unknown as Response),
  );
});

async function importPage() {
  const mod = await import("@/app/(dashboard)/knowledge/page");
  return mod.default;
}

test("offline ask renders snapshot badge when cached match exists", async () => {
  const { cacheRagResult } = require(
    "@/lib/rag-offline",
  ) as typeof import("@/lib/rag-offline");
  const {
    clearAllResources,
    __resetForTests,
  } = require("@/lib/offline-cache") as typeof import("@/lib/offline-cache");
  __resetForTests();
  await clearAllResources();

  await cacheRagResult("knowledge", {
    query: "payroll schedule",
    retrieved_docs: [
      { id: "k-7", title: "payroll schedule", content: "Every other Friday" },
    ],
    answer: "Every other Friday",
    sources: [{ id: "k-7", title: "payroll schedule" }],
    scope: "knowledge",
  });

  Object.defineProperty(navigator, "onLine", {
    value: false,
    configurable: true,
  });

  const Page = await importPage();
  await act(async () => {
    render(<Page />);
  });

  // Open the "Ask a Question" panel.
  const askToggle = await screen.findByRole("button", {
    name: /ask a question/i,
  });
  await act(async () => {
    fireEvent.click(askToggle);
  });

  const input = await screen.findByPlaceholderText(/what would you like to know/i);
  await act(async () => {
    fireEvent.change(input, { target: { value: "payroll schedule" } });
  });
  const submit = screen.getByRole("button", { name: /^Ask$/i });
  await act(async () => {
    fireEvent.click(submit);
  });

  await waitFor(() => {
    expect(screen.getByTestId("knowledge-snapshot-badge")).toBeInTheDocument();
  });
  expect(screen.getByText(/Every other Friday/)).toBeInTheDocument();

  Object.defineProperty(navigator, "onLine", {
    value: true,
    configurable: true,
  });
  await clearAllResources();
});

test("offline ask with no cache shows 'connect and ask' copy", async () => {
  const {
    clearAllResources,
    __resetForTests,
  } = require("@/lib/offline-cache") as typeof import("@/lib/offline-cache");
  __resetForTests();
  await clearAllResources();

  Object.defineProperty(navigator, "onLine", {
    value: false,
    configurable: true,
  });

  const Page = await importPage();
  await act(async () => {
    render(<Page />);
  });

  const askToggle = await screen.findByRole("button", { name: /ask a question/i });
  await act(async () => {
    fireEvent.click(askToggle);
  });

  const input = await screen.findByPlaceholderText(/what would you like to know/i);
  await act(async () => {
    fireEvent.change(input, { target: { value: "never asked before" } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^Ask$/i }));
  });

  await waitFor(() => {
    expect(screen.getByTestId("knowledge-offline-miss")).toBeInTheDocument();
  });

  Object.defineProperty(navigator, "onLine", {
    value: true,
    configurable: true,
  });
});

test("?id=<entryId> deep-link auto-selects + expands the matching entry", async () => {
  // Mount with a deep-link URL — search results / external links land
  // here. The entry must already be expanded so the user reads the
  // answer immediately, no extra click.
  window.history.replaceState({}, "", "/knowledge?id=k-deep-1");

  const SAMPLE = {
    id: "k-deep-1",
    question: "What does PCNA stand for?",
    answer: "Porsche Cars North America.",
    source: "human",
    asked_by: "u1",
    confidence: 0.9,
    rating: null,
    view_count: 0,
    tokens_used: 0,
    tags: [],
    created_at: "2026-04-20T00:00:00Z",
    updated_at: "2026-04-20T00:00:00Z",
  };

  fetchMock.mockImplementation((url: unknown) => {
    if (typeof url === "string" && url.includes("/api/knowledge")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ entries: [SAMPLE] }),
      } as unknown as Response);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    } as unknown as Response);
  });

  const Page = await importPage();
  await act(async () => {
    render(<Page />);
  });

  // The entry container exists with the deep-link data attribute.
  await waitFor(() => {
    expect(
      document.querySelector('[data-knowledge-entry="k-deep-1"]'),
    ).toBeInTheDocument();
  });
  // The expanded body shows up (selected state renders the answer).
  await waitFor(() => {
    expect(screen.getByText("Porsche Cars North America.")).toBeInTheDocument();
  });

  // URL cleanup so this leak doesn't affect later tests.
  window.history.replaceState({}, "", "/knowledge");
});

test("?id=<missingId> fallthrough: no crash, no entry selected", async () => {
  window.history.replaceState({}, "", "/knowledge?id=does-not-exist");
  fetchMock.mockImplementation(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ entries: [] }),
    } as unknown as Response),
  );

  const Page = await importPage();
  await act(async () => {
    render(<Page />);
  });

  // Empty state renders — no crash from the deep-link resolver.
  await waitFor(() => {
    expect(
      screen.getByText(/No knowledge entries found/i),
    ).toBeInTheDocument();
  });

  window.history.replaceState({}, "", "/knowledge");
});
