/**
 * @jest-environment jsdom
 *
 * Discussions page — verifies that the new-thread and reply forms route
 * through the offline-aware discussions wrapper so that a submission
 * while offline enqueues the mutation for replay (vs. silently failing).
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
  // GET /api/discussions returns an empty list on initial load.
  fetchMock.mockImplementation((url: RequestInfo | URL) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("/api/discussions") && !u.includes("/api/discussions/")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ threads: [] }),
      } as unknown as Response);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    } as unknown as Response);
  });
});

async function importPage() {
  const mod = await import("@/app/(dashboard)/discussions/page");
  return mod.default;
}

test("offline new-thread form enqueues via the wrapper and surfaces 'will send when online'", async () => {
  const {
    clearQueue,
    listQueue,
    __resetForTests: resetQueue,
  } = require("@/lib/offline-queue") as typeof import("@/lib/offline-queue");
  resetQueue();
  await clearQueue();

  Object.defineProperty(navigator, "onLine", {
    value: false,
    configurable: true,
  });

  const Page = await importPage();
  await act(async () => {
    render(<Page />);
  });

  // Open new-thread form.
  const newButton = await screen.findByRole("button", { name: /new discussion/i });
  await act(async () => {
    fireEvent.click(newButton);
  });

  const title = await screen.findByPlaceholderText(/discussion title/i);
  const content = await screen.findByPlaceholderText(/start the discussion/i);
  await act(async () => {
    fireEvent.change(title, { target: { value: "Offline thread" } });
    fireEvent.change(content, { target: { value: "Hello from offline" } });
  });
  const submit = screen.getByRole("button", { name: /create discussion/i });
  await act(async () => {
    fireEvent.click(submit);
  });

  // UI shows the "will send when online" ack.
  await waitFor(() => {
    expect(screen.getByText(/will send when online/i)).toBeInTheDocument();
  });

  // Mutation was queued on the right endpoint with the right payload.
  const rows = await listQueue();
  expect(rows).toHaveLength(1);
  expect(rows[0].endpoint).toBe("/api/discussions");
  expect(rows[0].method).toBe("POST");
  expect(rows[0].headers["x-instinct-resource-type"]).toBe("discussion_thread");
  expect(JSON.parse(rows[0].body!)).toEqual({
    title: "Offline thread",
    category: "general",
    content: "Hello from offline",
  });

  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  await clearQueue();
});
