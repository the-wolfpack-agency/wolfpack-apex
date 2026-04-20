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
