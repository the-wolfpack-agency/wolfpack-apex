/**
 * @jest-environment jsdom
 *
 * /knowledge — AI badge + feedback button tests.
 *
 * Two render branches:
 *   1. /api/knowledge/ask returns source='ai_generated' → AI badge appears.
 *   2. /api/knowledge/ask returns source='internal_doc' → AI badge does not.
 *
 * The thumbs-up / thumbs-down click fires a POST to /api/knowledge/feedback.
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

jest.mock("@/lib/knowledge-capture-offline", () => ({
  saveKnowledgeEntryOffline: jest.fn(),
  updateKnowledgeEntryOffline: jest.fn(),
  deleteKnowledgeEntryOffline: jest.fn(),
}));

jest.mock("@/lib/knowledge-rag-offline", () => ({
  queryKnowledgeWithCache: jest.fn(),
  RagOfflineMissError: class RagOfflineMissError extends Error {},
}));

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetchWithRefresh(...a),
  authHeaders: () => ({ Authorization: "Bearer x" }),
  jsonHeaders: () => ({
    "Content-Type": "application/json",
    Authorization: "Bearer x",
  }),
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
});

async function importPage() {
  const mod = await import("@/app/(dashboard)/knowledge/page");
  return mod.default;
}

function mockAskResponse(payload: unknown) {
  mockFetchWithRefresh.mockImplementation(async (url: string) => {
    if (url.includes("/api/knowledge/ask")) {
      return {
        ok: true,
        status: 200,
        json: async () => payload,
      } as unknown as Response;
    }
    if (url.includes("/api/knowledge/feedback")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response;
  });
}

test("AI badge appears when source='ai_generated'", async () => {
  mockAskResponse({
    qa_id: "q-ai",
    answer: "Generated answer.",
    source: "ai_generated",
    ai_model: "anthropic/claude-haiku-4.5",
    ai_generated_at: "2026-04-29T00:00:00Z",
    was_cache_hit: false,
  });
  const Page = await importPage();
  await act(async () => {
    render(<Page />);
  });
  fireEvent.click(screen.getByRole("button", { name: /ask a question/i }));
  fireEvent.change(
    screen.getByPlaceholderText(/what would you like to know/i),
    { target: { value: "How do I reset my password?" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
  await waitFor(() => {
    expect(screen.getByTestId("knowledge-ai-badge")).toBeInTheDocument();
  });
});

test("AI badge does NOT appear when source='internal_doc'", async () => {
  mockAskResponse({
    qa_id: "q-doc",
    answer: "From the runbook.",
    source: "internal_doc",
    ai_model: null,
    ai_generated_at: null,
    was_cache_hit: true,
  });
  const Page = await importPage();
  await act(async () => {
    render(<Page />);
  });
  fireEvent.click(screen.getByRole("button", { name: /ask a question/i }));
  fireEvent.change(
    screen.getByPlaceholderText(/what would you like to know/i),
    { target: { value: "What is the deploy runbook?" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
  await waitFor(() => {
    expect(screen.getByTestId("knowledge-feedback-row")).toBeInTheDocument();
  });
  expect(screen.queryByTestId("knowledge-ai-badge")).not.toBeInTheDocument();
});

test("clicking Helpful POSTs to /api/knowledge/feedback", async () => {
  mockAskResponse({
    qa_id: "q-fb",
    answer: "An answer.",
    source: "ai_generated",
    ai_model: "x/y",
    ai_generated_at: "2026-04-29T00:00:00Z",
    was_cache_hit: false,
  });
  const Page = await importPage();
  await act(async () => {
    render(<Page />);
  });
  fireEvent.click(screen.getByRole("button", { name: /ask a question/i }));
  fireEvent.change(
    screen.getByPlaceholderText(/what would you like to know/i),
    { target: { value: "How do I deploy?" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
  await waitFor(() =>
    expect(screen.getByTestId("knowledge-feedback-helpful")).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByTestId("knowledge-feedback-helpful"));
  await waitFor(() => {
    const calls = mockFetchWithRefresh.mock.calls.filter((c) =>
      String(c[0]).includes("/api/knowledge/feedback"),
    );
    expect(calls.length).toBeGreaterThan(0);
    const body = JSON.parse(String((calls[0][1] as { body: string }).body));
    expect(body).toEqual(
      expect.objectContaining({ qa_id: "q-fb", helpful: true }),
    );
  });
});
