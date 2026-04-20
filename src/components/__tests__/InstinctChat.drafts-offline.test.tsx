/**
 * @jest-environment jsdom
 *
 * InstinctChat — Stream U2 user-message send path wiring. When the RAG
 * cache path misses offline (the primary "happy path" for a chat user
 * who types something they've never asked before), the component must
 * route the USER MESSAGE through `sendAssistantMessageOffline` so the
 * outgoing POST is queued and replayed on reconnect, not dropped.
 *
 * This is the "will send when online" contract. Separate from
 * `InstinctChat.rag-offline.test.tsx` which covers the RAG cache-hit +
 * cache-miss fallback copy.
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
  if (!(Element.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView) {
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView =
      () => undefined;
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

test("offline + no cache → queues the outgoing user message for replay on reconnect", async () => {
  const {
    clearAllResources,
    __resetForTests: resetCache,
  } = require("@/lib/offline-cache") as typeof import("@/lib/offline-cache");
  const {
    clearQueue,
    listQueue,
    __resetForTests: resetQueue,
  } = require("@/lib/offline-queue") as typeof import("@/lib/offline-queue");
  resetCache();
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
    fireEvent.change(textarea, { target: { value: "brand new question" } });
  });
  const send = screen
    .getAllByRole("button")
    .find((b) => b.querySelector("svg path[d^='M6 12']") !== null)!;
  await act(async () => {
    fireEvent.click(send);
  });

  // Ack surfaces to the user.
  await waitFor(() => {
    expect(
      screen.getByText(/will send when you're back online/i),
    ).toBeInTheDocument();
  });

  // Outgoing POST is queued at /api/assistant with the right payload.
  const rows = await listQueue();
  const assistantRows = rows.filter((r) => r.endpoint === "/api/assistant");
  expect(assistantRows).toHaveLength(1);
  expect(assistantRows[0].method).toBe("POST");
  expect(assistantRows[0].headers["x-instinct-resource-type"]).toBe(
    "assistant_message",
  );
  const body = JSON.parse(assistantRows[0].body!);
  expect(body.message).toBe("brand new question");

  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  await clearQueue();
});
