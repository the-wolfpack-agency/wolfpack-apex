/**
 * @jest-environment jsdom
 *
 * /knowledge — simplified quick-add UX. A single textarea + optional
 * title + Save button is the primary add path; the structured Q/A form
 * sits behind an "Advanced" disclosure. Triple-write still fires via
 * the underlying /api/knowledge POST (saveKnowledgeEntryOffline).
 */

import "fake-indexeddb/auto";
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/lib/knowledge-capture-offline", () => ({
  saveKnowledgeEntryOffline: jest.fn().mockResolvedValue({
    status: "created",
    id: "new-1",
    queueId: null,
  }),
  updateKnowledgeEntryOffline: jest.fn().mockResolvedValue({ status: "created", id: "x", queueId: null }),
  deleteKnowledgeEntryOffline: jest.fn().mockResolvedValue({ status: "deleted", id: "x", queueId: null }),
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
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  authHeaders: () => ({ Authorization: "Bearer x" }),
  jsonHeaders: () => ({ "Content-Type": "application/json", Authorization: "Bearer x" }),
}));

const offline = jest.requireMock("@/lib/knowledge-capture-offline") as {
  saveKnowledgeEntryOffline: jest.Mock;
};

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
  offline.saveKnowledgeEntryOffline.mockClear();
  fetchMock.mockImplementation(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ entries: [] }),
      text: () => Promise.resolve("{}"),
    } as unknown as Response),
  );
  mockFetchWithRefresh.mockImplementation(() =>
    Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as any),
  );
});

async function importPage() {
  const mod = await import("@/app/(dashboard)/knowledge/page");
  return mod.default;
}

test("Quick Add panel surfaces a single textarea + title; structured form is behind Advanced", async () => {
  const Page = await importPage();
  await act(async () => {
    render(<Page />);
  });

  const toggle = await screen.findByTestId("knowledge-add-toggle");
  await act(async () => {
    fireEvent.click(toggle);
  });

  expect(screen.getByTestId("knowledge-quick-add-panel")).toBeInTheDocument();
  expect(screen.getByTestId("knowledge-quick-add-title")).toBeInTheDocument();
  expect(screen.getByTestId("knowledge-quick-add-content")).toBeInTheDocument();
  // Structured panel is NOT present until Advanced is expanded.
  expect(screen.queryByTestId("knowledge-capture-panel")).toBeNull();

  await act(async () => {
    fireEvent.click(screen.getByTestId("knowledge-advanced-toggle"));
  });
  expect(screen.getByTestId("knowledge-capture-panel")).toBeInTheDocument();
});

test("Quick Add with freeform dump saves as a 'note' (title fallback = first 60 chars)", async () => {
  const Page = await importPage();
  await act(async () => {
    render(<Page />);
  });
  await act(async () => {
    fireEvent.click(await screen.findByTestId("knowledge-add-toggle"));
  });

  const content = screen.getByTestId("knowledge-quick-add-content");
  await act(async () => {
    fireEvent.change(content, {
      target: { value: "Payroll runs every other Friday. Submit timesheets by Wed 5pm." },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("knowledge-quick-add-save"));
  });

  await waitFor(() => {
    expect(offline.saveKnowledgeEntryOffline).toHaveBeenCalled();
  });
  const payload = offline.saveKnowledgeEntryOffline.mock.calls[0][0];
  expect(payload.source).toBe("human");
  // Note classification fallback: tags include "note" + answer == full content.
  expect(payload.tags).toEqual(expect.arrayContaining(["note"]));
  expect(payload.answer).toContain("Payroll runs every other Friday");

  // Analytics event fired.
  const analyticsCalls = mockFetchWithRefresh.mock.calls
    .filter((c) => c[0] === "/api/analytics")
    .map((c) => JSON.parse(c[1].body));
  expect(
    analyticsCalls.some((p) => p.event === "knowledge.quick_add" && p.metadata.classified_as === "note"),
  ).toBe(true);
});

test("Quick Add with explicit title uses the title as the question", async () => {
  const Page = await importPage();
  await act(async () => {
    render(<Page />);
  });
  await act(async () => {
    fireEvent.click(await screen.findByTestId("knowledge-add-toggle"));
  });

  await act(async () => {
    fireEvent.change(screen.getByTestId("knowledge-quick-add-title"), {
      target: { value: "Payroll schedule" },
    });
    fireEvent.change(screen.getByTestId("knowledge-quick-add-content"), {
      target: { value: "Every other Friday." },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("knowledge-quick-add-save"));
  });

  await waitFor(() => {
    expect(offline.saveKnowledgeEntryOffline).toHaveBeenCalled();
  });
  const payload = offline.saveKnowledgeEntryOffline.mock.calls[0][0];
  expect(payload.question).toBe("Payroll schedule");
  expect(payload.answer).toBe("Every other Friday.");
});

test("Quick Add auto-classifies lines ending in '?' as Q&A", async () => {
  const Page = await importPage();
  await act(async () => {
    render(<Page />);
  });
  await act(async () => {
    fireEvent.click(await screen.findByTestId("knowledge-add-toggle"));
  });

  await act(async () => {
    fireEvent.change(screen.getByTestId("knowledge-quick-add-content"), {
      target: { value: "How do we rotate JWTs?\nThe refresh cookie auto-rotates via fetchWithRefresh." },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("knowledge-quick-add-save"));
  });

  await waitFor(() => {
    expect(offline.saveKnowledgeEntryOffline).toHaveBeenCalled();
  });
  const payload = offline.saveKnowledgeEntryOffline.mock.calls[0][0];
  expect(payload.question).toBe("How do we rotate JWTs?");
  expect(payload.answer).toContain("refresh cookie auto-rotates");

  const analyticsCalls = mockFetchWithRefresh.mock.calls
    .filter((c) => c[0] === "/api/analytics")
    .map((c) => JSON.parse(c[1].body));
  expect(
    analyticsCalls.some((p) => p.event === "knowledge.quick_add" && p.metadata.classified_as === "qa"),
  ).toBe(true);
});

test("Quick Add refuses an empty paste (no backend call)", async () => {
  const Page = await importPage();
  await act(async () => {
    render(<Page />);
  });
  await act(async () => {
    fireEvent.click(await screen.findByTestId("knowledge-add-toggle"));
  });

  await act(async () => {
    fireEvent.click(screen.getByTestId("knowledge-quick-add-save"));
  });

  expect(offline.saveKnowledgeEntryOffline).not.toHaveBeenCalled();
  expect(screen.getByTestId("knowledge-quick-add-msg")).toHaveTextContent(/paste/i);
});
