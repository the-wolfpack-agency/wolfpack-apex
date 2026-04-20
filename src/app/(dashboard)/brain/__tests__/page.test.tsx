/**
 * @jest-environment jsdom
 *
 * /brain page render + interaction test.
 *
 * Verifies:
 *   - Page mounts without errors
 *   - Dropzone + upload progress visible
 *   - Library grid renders returned documents
 *   - Query submit hits /api/brain/query and renders hits
 *
 * Uses a fetch mock shared across requests. The document list + query
 * responses are configured per-test.
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const fetchMock = jest.fn();

beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
  Object.defineProperty(window, "localStorage", {
    value: {
      _store: { instinct_access_token: "t" } as Record<string, string>,
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
});

function jsonOk(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response);
}

function setupFetchQueue(responses: Array<() => Promise<Response>>) {
  const queue = [...responses];
  fetchMock.mockImplementation(() => {
    const next = queue.shift();
    if (!next) return jsonOk({}); // fallback — any stray fetch is harmless
    return next();
  });
}

async function importPage() {
  const mod = await import("@/app/(dashboard)/brain/page");
  return mod.default;
}

// ── render ────────────────────────────────────────────────────────

test("renders the Brain dashboard with header + dropzone", async () => {
  setupFetchQueue([
    () => jsonOk({ documents: [], count: 0, filters: {} }),
    () => jsonOk({}), // analytics ping
  ]);
  const Page = await importPage();
  await act(async () => {
    render(<Page />);
  });
  await waitFor(() => {
    expect(screen.getByText(/Central Brain/i)).toBeInTheDocument();
  });
  expect(screen.getByText(/Drop files to add to the Brain/i)).toBeInTheDocument();
  expect(screen.getByPlaceholderText(/dealer escalation/i)).toBeInTheDocument();
});

test("renders documents from the library fetch", async () => {
  const docs = [
    {
      id: "doc-1",
      filename: "onboarding-checklist.md",
      content_type: "text/markdown",
      size_bytes: 4096,
      kind: "markdown",
      status: "indexed",
      status_detail: null,
      chunk_count: 5,
      extracted_chars: 3200,
      tokens_used: 0,
      uploaded_by: "u1",
      tags: ["hr"],
      created_at: "2026-04-17T12:00:00Z",
      updated_at: "2026-04-17T12:00:00Z",
      indexed_at: "2026-04-17T12:00:00Z",
    },
  ];
  setupFetchQueue([
    () => jsonOk({ documents: docs, count: 1, filters: {} }),
    () => jsonOk({}),
  ]);
  const Page = await importPage();
  await act(async () => {
    render(<Page />);
  });
  await waitFor(() => {
    expect(screen.getByText("onboarding-checklist.md")).toBeInTheDocument();
  });
  // Status pill is inside the doc card — assert on the card scope to
  // disambiguate from the "N documents indexed" header metric.
  const card = screen.getByTestId("doc-card");
  expect(card).toHaveTextContent(/indexed/i);
  expect(card).toHaveTextContent(/5 chunks/i);
});

test("query form posts to /api/brain/query and renders hits", async () => {
  const queryResponse = {
    query: "escalation",
    hits: [
      {
        chunk_id: "c1",
        document_id: "d1",
        document_filename: "playbook.pdf",
        document_kind: "pdf",
        chunk_idx: 0,
        content: "When a dealer escalates an issue, first check the status portal…",
        score: 0.42,
        source: "keyword",
        snippet: "When a dealer escalates…",
      },
    ],
    keyword_hits: 1,
    semantic_hits: 0,
    latency_ms: 30,
    tokens_used: 0,
    query_log_id: 7,
  };
  setupFetchQueue([
    () => jsonOk({ documents: [], count: 0, filters: {} }),
    () => jsonOk({}), // analytics ping
    () => jsonOk(queryResponse),
  ]);
  const Page = await importPage();
  await act(async () => {
    render(<Page />);
  });

  const input = await screen.findByPlaceholderText(/dealer escalation/i);
  await act(async () => {
    fireEvent.change(input, { target: { value: "how do we escalate" } });
  });
  const btn = screen.getByRole("button", { name: /search/i });
  await act(async () => {
    fireEvent.click(btn);
  });

  await waitFor(() => {
    expect(screen.getByTestId("query-result")).toBeInTheDocument();
  });
  expect(screen.getByText(/playbook\.pdf/)).toBeInTheDocument();
});

test("empty library shows a nudge to upload", async () => {
  setupFetchQueue([
    () => jsonOk({ documents: [], count: 0, filters: {} }),
    () => jsonOk({}),
  ]);
  const Page = await importPage();
  await act(async () => {
    render(<Page />);
  });
  await waitFor(() => {
    expect(screen.getByText(/Drop a file above/i)).toBeInTheDocument();
  });
});

test("snippet renders ts_headline <b> as <strong> and escapes hostile HTML", async () => {
  const hostileSnippet =
    'A dealer <script>alert(1)</script> wants to <b>escalate</b> their ' +
    '<img src=x onerror=alert(2)> issue. <b>urgent</b>';
  const queryResponse = {
    query: "escalate",
    hits: [
      {
        chunk_id: "c1",
        document_id: "d1",
        document_filename: "hostile.pdf",
        document_kind: "pdf",
        chunk_idx: 0,
        content: "…",
        score: 0.5,
        source: "keyword",
        snippet: hostileSnippet,
      },
    ],
    keyword_hits: 1,
    semantic_hits: 0,
    latency_ms: 5,
    tokens_used: 0,
    query_log_id: 11,
  };
  setupFetchQueue([
    () => jsonOk({ documents: [], count: 0, filters: {} }),
    () => jsonOk({}),
    () => jsonOk(queryResponse),
  ]);
  const Page = await importPage();
  await act(async () => {
    render(<Page />);
  });

  const input = await screen.findByPlaceholderText(/dealer escalation/i);
  await act(async () => {
    fireEvent.change(input, { target: { value: "escalate" } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
  });

  const result = await screen.findByTestId("query-result");

  // ts_headline <b> boundaries become <strong> elements (at least 2)
  const strongs = result.querySelectorAll("strong");
  expect(strongs.length).toBeGreaterThanOrEqual(2);
  // Matched tokens render as *text content* of <strong>, not as raw HTML
  expect(Array.from(strongs).map((s) => s.textContent)).toEqual(
    expect.arrayContaining(["escalate", "urgent"]),
  );

  // Hostile HTML must be rendered as visible, inert text — no element injection
  expect(result.querySelector("script")).toBeNull();
  expect(result.querySelector("img")).toBeNull();
  // The literal text stays visible so users can still see what matched
  expect(result.textContent).toContain("<script>");
  expect(result.textContent).toContain("<img src=x onerror=alert(2)>");
});

test("offline query hits cached result and renders RagSnapshotBadge", async () => {
  // Seed the cache directly via U1's primitive then flip offline
  // before render so the component's query goes through the cache
  // path. No network fetch for /api/brain/query should fire.
  require("fake-indexeddb/auto");
  const {
    cacheRagResult,
  } = require("@/lib/rag-offline") as typeof import("@/lib/rag-offline");
  const { clearAllResources, __resetForTests } = require(
    "@/lib/offline-cache",
  ) as typeof import("@/lib/offline-cache");
  __resetForTests();
  await clearAllResources();
  const hits = [
    {
      chunk_id: "c-off",
      document_id: "d-off",
      document_filename: "snap.pdf",
      document_kind: "pdf",
      chunk_idx: 0,
      content: "body",
      score: 0.9,
      source: "keyword" as const,
      snippet: "snap snippet",
    },
  ];
  await cacheRagResult("brain", {
    query: "escalate offline",
    retrieved_docs: [
      {
        id: "__brain_extras__",
        title: "__brain_extras__",
        content: JSON.stringify({
          hits,
          keyword_hits: 1,
          semantic_hits: 0,
          latency_ms: 1,
          tokens_used: 0,
          query_log_id: 99,
        }),
      },
      ...hits.map((h) => ({
        id: h.chunk_id,
        title: h.document_filename,
        content: h.content,
      })),
    ],
    answer: hits[0].snippet,
    sources: hits.map((h) => ({
      id: h.chunk_id,
      title: h.document_filename,
      score: h.score,
    })),
    scope: "brain",
  });

  setupFetchQueue([
    () => jsonOk({ documents: [], count: 0, filters: {} }),
    () => jsonOk({}),
  ]);

  Object.defineProperty(navigator, "onLine", {
    value: false,
    configurable: true,
  });

  const Page = await importPage();
  await act(async () => {
    render(<Page />);
  });
  const input = await screen.findByPlaceholderText(/dealer escalation/i);
  await act(async () => {
    fireEvent.change(input, { target: { value: "escalate offline" } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
  });
  await waitFor(() => {
    expect(screen.getByTestId("brain-snapshot-badge")).toBeInTheDocument();
  });
  expect(screen.getByText(/snap\.pdf/)).toBeInTheDocument();
  const queryCalls = fetchMock.mock.calls
    .map((c) => (typeof c[0] === "string" ? c[0] : ""))
    .filter((u) => u.includes("/api/brain/query"));
  expect(queryCalls).toHaveLength(0);

  // Restore online for later tests.
  Object.defineProperty(navigator, "onLine", {
    value: true,
    configurable: true,
  });
  await clearAllResources();
});

test("Mine / All toggle switches the uploaded_by filter", async () => {
  // first load (mine), then second load (all)
  setupFetchQueue([
    () => jsonOk({ documents: [], count: 0, filters: {} }), // mine
    () => jsonOk({}), // analytics ping
    () => jsonOk({ documents: [], count: 0, filters: {} }), // all
  ]);
  const Page = await importPage();
  await act(async () => {
    render(<Page />);
  });
  const allBtn = await screen.findByRole("button", { name: /^All$/ });
  await act(async () => {
    fireEvent.click(allBtn);
  });

  // Find the documents-fetch calls (skip analytics)
  const urls = fetchMock.mock.calls
    .map((c) => (typeof c[0] === "string" ? c[0] : ""))
    .filter((u) => u.includes("/api/brain/documents"));
  expect(urls.length).toBeGreaterThanOrEqual(2);
  expect(urls[1]).toContain("uploaded_by=all");
});
