/**
 * @jest-environment jsdom
 *
 * /knowledge page — edit + delete flow. Covers:
 *   - Edit button reveals an inline form pre-filled with the row's values
 *   - Save calls updateKnowledgeEntryOffline + refetches the list
 *   - Only one row is editable at a time
 *   - Delete confirm-cancel skips the network call
 *   - Delete confirm-accept calls deleteKnowledgeEntryOffline
 */

import "fake-indexeddb/auto";
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Mock the offline helpers so we can assert calls cleanly.
jest.mock("@/lib/knowledge-capture-offline", () => ({
  saveKnowledgeEntryOffline: jest.fn().mockResolvedValue({
    status: "created",
    id: "new-1",
    queueId: null,
  }),
  updateKnowledgeEntryOffline: jest.fn().mockResolvedValue({
    status: "created",
    id: "k-1",
    queueId: null,
  }),
  deleteKnowledgeEntryOffline: jest.fn().mockResolvedValue({
    status: "deleted",
    id: "k-1",
    queueId: null,
  }),
}));

// Stub the RAG wrapper — not relevant to edit tests.
jest.mock("@/lib/knowledge-rag-offline", () => ({
  queryKnowledgeWithCache: jest.fn().mockResolvedValue({
    from_cache: false,
    answer: null,
    server_has_no_answer: true,
    sources: [],
  }),
  RagOfflineMissError: class RagOfflineMissError extends Error {},
}));

const offline = jest.requireMock("@/lib/knowledge-capture-offline") as {
  saveKnowledgeEntryOffline: jest.Mock;
  updateKnowledgeEntryOffline: jest.Mock;
  deleteKnowledgeEntryOffline: jest.Mock;
};

const SEED_ENTRIES = [
  {
    id: "k-1",
    question: "How do we rotate JWTs?",
    answer: "Refresh cookie auto-rotates via fetchWithRefresh.",
    source: "human",
    asked_by: "",
    confidence: 1,
    rating: null,
    view_count: 5,
    tokens_used: 0,
    tags: ["auth"],
    created_at: new Date().toISOString(),
  },
  {
    id: "k-2",
    question: "How do we handle payroll?",
    answer: "Every other Friday.",
    source: "human",
    asked_by: "",
    confidence: 1,
    rating: null,
    view_count: 2,
    tokens_used: 0,
    tags: ["hr"],
    created_at: new Date().toISOString(),
  },
];

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
  // Default: every /api/knowledge?... fetch returns SEED_ENTRIES, every
  // other call is a benign 200.
  fetchMock.mockImplementation((url: string) => {
    const body =
      typeof url === "string" && url.startsWith("/api/knowledge")
        ? { entries: SEED_ENTRIES }
        : {};
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    } as unknown as Response);
  });
  offline.updateKnowledgeEntryOffline.mockClear();
  offline.deleteKnowledgeEntryOffline.mockClear();
  offline.updateKnowledgeEntryOffline.mockResolvedValue({
    status: "created",
    id: "k-1",
    queueId: null,
  });
  offline.deleteKnowledgeEntryOffline.mockResolvedValue({
    status: "deleted",
    id: "k-1",
    queueId: null,
  });
});

async function renderPage() {
  const mod = await import("@/app/(dashboard)/knowledge/page");
  const Page = mod.default;
  await act(async () => {
    render(<Page />);
  });
  // Wait for the initial fetchEntries to resolve.
  await waitFor(() => {
    expect(screen.getByText(/How do we rotate JWTs/)).toBeInTheDocument();
  });
}

test("Edit button reveals form pre-filled with entry values", async () => {
  await renderPage();

  const editBtn = screen.getByTestId("knowledge-edit-btn-k-1");
  await act(async () => {
    fireEvent.click(editBtn);
  });

  const form = await screen.findByTestId("knowledge-edit-form-k-1");
  expect(form).toBeInTheDocument();

  const q = screen.getByLabelText(/edit question/i) as HTMLInputElement;
  const a = screen.getByLabelText(/edit answer/i) as HTMLTextAreaElement;
  const tags = screen.getByLabelText(/edit tags/i) as HTMLInputElement;
  expect(q.value).toBe("How do we rotate JWTs?");
  expect(a.value).toBe("Refresh cookie auto-rotates via fetchWithRefresh.");
  expect(tags.value).toBe("auth");
});

test("Save calls updateKnowledgeEntryOffline with edited fields + refetches list", async () => {
  await renderPage();

  await act(async () => {
    fireEvent.click(screen.getByTestId("knowledge-edit-btn-k-1"));
  });

  const q = await screen.findByLabelText(/edit question/i);
  const a = screen.getByLabelText(/edit answer/i);
  const tags = screen.getByLabelText(/edit tags/i);

  await act(async () => {
    fireEvent.change(q, { target: { value: "NEW Q" } });
    fireEvent.change(a, { target: { value: "NEW A" } });
    fireEvent.change(tags, { target: { value: "auth, jwt" } });
  });

  const fetchCallsBefore = fetchMock.mock.calls.filter((c) =>
    typeof c[0] === "string" && (c[0] as string).startsWith("/api/knowledge"),
  ).length;

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
  });

  await waitFor(() => {
    expect(offline.updateKnowledgeEntryOffline).toHaveBeenCalledTimes(1);
  });
  const arg = offline.updateKnowledgeEntryOffline.mock.calls[0][0];
  expect(arg).toMatchObject({
    entry_id: "k-1",
    question: "NEW Q",
    answer: "NEW A",
    tags: ["auth", "jwt"],
    source: "human",
  });
  expect(typeof arg.updated_at).toBe("number");

  // Refetch fired after save.
  await waitFor(() => {
    const after = fetchMock.mock.calls.filter((c) =>
      typeof c[0] === "string" && (c[0] as string).startsWith("/api/knowledge"),
    ).length;
    expect(after).toBeGreaterThan(fetchCallsBefore);
  });
});

test("Only one row editable at a time — clicking Edit on row B collapses row A", async () => {
  await renderPage();

  await act(async () => {
    fireEvent.click(screen.getByTestId("knowledge-edit-btn-k-1"));
  });
  expect(await screen.findByTestId("knowledge-edit-form-k-1")).toBeInTheDocument();

  await act(async () => {
    fireEvent.click(screen.getByTestId("knowledge-edit-btn-k-2"));
  });

  await waitFor(() => {
    expect(screen.queryByTestId("knowledge-edit-form-k-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("knowledge-edit-form-k-2")).toBeInTheDocument();
  });
});

test("Delete confirm-cancel does NOT call the network", async () => {
  await renderPage();

  const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(false);
  try {
    await act(async () => {
      fireEvent.click(screen.getByTestId("knowledge-delete-btn-k-1"));
    });

    expect(confirmSpy).toHaveBeenCalled();
    // brief microtask flush
    await Promise.resolve();
    expect(offline.deleteKnowledgeEntryOffline).not.toHaveBeenCalled();
    // Row still rendered.
    expect(screen.getByText(/How do we rotate JWTs/)).toBeInTheDocument();
  } finally {
    confirmSpy.mockRestore();
  }
});

test("Delete confirm-accept calls deleteKnowledgeEntryOffline + removes row optimistically", async () => {
  await renderPage();

  const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
  try {
    await act(async () => {
      fireEvent.click(screen.getByTestId("knowledge-delete-btn-k-1"));
    });

    await waitFor(() => {
      expect(offline.deleteKnowledgeEntryOffline).toHaveBeenCalledWith("k-1");
    });
    await waitFor(() => {
      expect(screen.queryByText(/How do we rotate JWTs/)).not.toBeInTheDocument();
    });
    // Other row still there.
    expect(screen.getByText(/How do we handle payroll/)).toBeInTheDocument();
  } finally {
    confirmSpy.mockRestore();
  }
});
