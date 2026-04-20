/**
 * @jest-environment jsdom
 *
 * InstinctChat — Stream U2 integration. Verifies the offline RAG cache
 * path surfaces the cached answer + RagSnapshotBadge when a user sends
 * a message with no network, and surfaces a friendly offline-miss UI
 * when there's no cache to fall back to.
 */

import "fake-indexeddb/auto";
import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const fetchMock = jest.fn();

beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
  // jsdom doesn't implement scrollIntoView; stub it.
  if (!(Element.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView) {
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined;
  }
  Object.defineProperty(window, "localStorage", {
    value: {
      _store: { instinct_token: "t" } as Record<string, string>,
      getItem(this: { _store: Record<string, string> }, k: string) {
        return this._store[k] ?? null;
      },
      setItem(this: { _store: Record<string, string> }, k: string, v: string) {
        this._store[k] = v;
      },
      removeItem(this: { _store: Record<string, string> }, k: string) {
        delete this._store[k];
      },
      clear(this: { _store: Record<string, string> }) {
        this._store = {};
      },
    },
    writable: true,
  });
});

beforeEach(() => {
  fetchMock.mockReset();
  // Default: respond with an empty conversations list on GET.
  fetchMock.mockImplementation(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ conversations: [] }),
      text: () => Promise.resolve("{}"),
    } as unknown as Response),
  );
});

async function importComponent() {
  const mod = await import("@/components/InstinctChat");
  return mod.default;
}

test("offline + cached → renders cached answer with RagSnapshotBadge", async () => {
  const {
    cacheRagResult,
  } = require("@/lib/rag-offline") as typeof import("@/lib/rag-offline");
  const {
    clearAllResources,
    __resetForTests,
  } = require("@/lib/offline-cache") as typeof import("@/lib/offline-cache");
  __resetForTests();
  await clearAllResources();

  await cacheRagResult("assistant", {
    query: "what is the plan",
    retrieved_docs: [],
    answer: "The cached plan is X.",
    sources: [{ id: "s1", title: "Plan Doc" }],
    scope: "assistant",
  });

  Object.defineProperty(navigator, "onLine", {
    value: false,
    configurable: true,
  });

  const InstinctChat = await importComponent();
  await act(async () => {
    render(<InstinctChat showHistory={false} showSource showRating={false} />);
  });

  const textarea = await screen.findByPlaceholderText(/ask anything/i);
  await act(async () => {
    fireEvent.change(textarea, { target: { value: "what is the plan" } });
  });
  const send = screen.getAllByRole("button").find(
    (b) => b.querySelector("svg path[d^='M6 12']") !== null,
  )!;
  expect(send).toBeTruthy();
  await act(async () => {
    fireEvent.click(send);
  });

  await waitFor(() => {
    expect(screen.getByTestId("assistant-snapshot-badge")).toBeInTheDocument();
  });
  expect(screen.getByText("The cached plan is X.")).toBeInTheDocument();
  // Assistant endpoint should NOT have been called — offline.
  const assistantCalls = fetchMock.mock.calls
    .map((c) => (typeof c[0] === "string" ? c[0] : ""))
    .filter(
      (u) => u.includes("/api/assistant") && !u.includes("conversations"),
    );
  expect(assistantCalls).toHaveLength(0);

  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  await clearAllResources();
});

test("offline + no cache → queues the user message and shows a 'will send when online' ack", async () => {
  const {
    clearAllResources,
    __resetForTests,
  } = require("@/lib/offline-cache") as typeof import("@/lib/offline-cache");
  const {
    clearQueue,
    listQueue,
    __resetForTests: resetQueue,
  } = require("@/lib/offline-queue") as typeof import("@/lib/offline-queue");
  __resetForTests();
  resetQueue();
  await clearAllResources();
  await clearQueue();

  Object.defineProperty(navigator, "onLine", {
    value: false,
    configurable: true,
  });

  const InstinctChat = await importComponent();
  await act(async () => {
    render(<InstinctChat showHistory={false} />);
  });

  const textarea = await screen.findByPlaceholderText(/ask anything/i);
  await act(async () => {
    fireEvent.change(textarea, { target: { value: "never asked" } });
  });
  const send = screen.getAllByRole("button").find(
    (b) => b.querySelector("svg path[d^='M6 12']") !== null,
  )!;
  await act(async () => {
    fireEvent.click(send);
  });

  await waitFor(() => {
    expect(
      screen.getByText(/will send when you're back online/i),
    ).toBeInTheDocument();
  });

  // The user's message must be queued (not dropped) so flush-on-online
  // replays it when we reconnect.
  const rows = await listQueue();
  expect(rows.filter((r) => r.endpoint === "/api/assistant")).toHaveLength(1);

  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  await clearQueue();
});
