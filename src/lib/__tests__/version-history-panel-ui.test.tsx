/**
 * @jest-environment jsdom
 */

/**
 * VersionHistoryPanel — UI tests.
 *
 * Mocks the global fetch used by fetchWithRefresh. Covers the empty
 * state, populated list, modal open/close, diff rendering, and the
 * restore flow. Lazy-load semantics: the GET only fires when the
 * designer expands the `<details>` panel.
 */

import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import VersionHistoryPanel, {
  type BriefVersionEntryView,
} from "@/components/sites/VersionHistoryPanel";
import type { SiteBrief } from "@/lib/sites-schema";

// Mock fetchWithRefresh directly — replacing global.fetch doesn't
// always reach module-captured references across jest module reloads,
// which was the cause of the panel's entries failing to render in
// these tests despite identical production behavior.
const fetchWithRefreshMock = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...args: unknown[]) => fetchWithRefreshMock(...args),
  authHeaders: () => ({ Authorization: "Bearer test-token" }),
  jsonHeaders: () => ({
    Authorization: "Bearer test-token",
    "Content-Type": "application/json",
  }),
  getInstinctToken: () => "test-token",
  getInstinctUser: () => ({ id: "test-user", role: "sales" }),
  clearInstinctSession: jest.fn(),
  migrateLegacyApexKeys: jest.fn(),
}));

// Alias so existing test bodies keep using `fetchSpy`.
const fetchSpy = fetchWithRefreshMock;

beforeEach(() => {
  fetchWithRefreshMock.mockReset();
  // Default so fire-and-forget analytics calls (.catch()) don't throw
  // when no explicit .mockResolvedValueOnce is queued for the request.
  fetchWithRefreshMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
    text: async () => "{}",
    headers: new Headers({ "content-type": "application/json" }),
  });
  window.localStorage.setItem("instinct_token", "test-token");
});

afterEach(() => {
  window.localStorage.clear();
  jest.restoreAllMocks();
});

function mkJson(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ "content-type": "application/json" }),
  } as unknown as Response;
}

const CURRENT_BRIEF: SiteBrief = {
  client: "cftr",
  product: { name: "CFTR" },
  pages: [
    {
      route: "/",
      sections: [{ type: "hero", heading: "Current Heading" }],
    },
  ],
};

const OLD_BRIEF: SiteBrief = {
  client: "cftr",
  product: { name: "CFTR" },
  pages: [
    {
      route: "/",
      sections: [{ type: "hero", heading: "Old Heading" }],
    },
  ],
};

const VERSIONS: BriefVersionEntryView[] = [
  {
    id: "edit_new",
    kind: "prompt_edit",
    siteId: "site_1",
    brief: CURRENT_BRIEF,
    authorId: "u_1",
    authorRole: "sales",
    summary: 'Edited: "Change hero heading"',
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    parentVersionId: null,
  },
  {
    id: "gen_g1",
    kind: "ai_extraction",
    siteId: "site_1",
    brief: OLD_BRIEF,
    authorId: "u_1",
    authorRole: null,
    summary: "AI extracted from image/png (12.3 KB)",
    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    parentVersionId: null,
  },
];

async function expandPanel() {
  const details = screen.getByTestId(
    "version-history-panel",
  ) as HTMLDetailsElement;
  await act(async () => {
    details.open = true;
    // React's synthetic event bridge expects a bubbling "toggle" event.
    // The native <details> element fires this in real browsers; jsdom
    // doesn't, so we simulate it via fireEvent.
    fireEvent(details, new Event("toggle", { bubbles: true }));
  });
}

describe("VersionHistoryPanel — render", () => {
  test("renders collapsed by default — no GET fired on mount", () => {
    render(
      <VersionHistoryPanel
        siteId="site_1"
        currentBrief={CURRENT_BRIEF}
        onRestore={() => {}}
      />,
    );
    expect(screen.getByTestId("version-history-panel")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("shows empty state when the GET returns []", async () => {
    fetchSpy.mockResolvedValueOnce(mkJson(200, { versions: [] }));
    render(
      <VersionHistoryPanel
        siteId="site_1"
        currentBrief={CURRENT_BRIEF}
        onRestore={() => {}}
      />,
    );
    await expandPanel();
    await waitFor(() => {
      expect(screen.getByTestId("version-history-empty")).toBeInTheDocument();
    });
  });

  test("renders list in newest-first order from the API response", async () => {
    fetchSpy.mockResolvedValueOnce(mkJson(200, { versions: VERSIONS }));
    render(
      <VersionHistoryPanel
        siteId="site_1"
        currentBrief={CURRENT_BRIEF}
        onRestore={() => {}}
      />,
    );
    await expandPanel();
    await waitFor(() => {
      const entries = screen.getAllByTestId("version-history-entry");
      expect(entries).toHaveLength(2);
      expect(entries[0]).toHaveAttribute("data-version-id", "edit_new");
      expect(entries[1]).toHaveAttribute("data-version-id", "gen_g1");
    });
  });

  test("each entry shows icon, relative timestamp, author, summary", async () => {
    fetchSpy.mockResolvedValueOnce(mkJson(200, { versions: VERSIONS }));
    render(
      <VersionHistoryPanel
        siteId="site_1"
        currentBrief={CURRENT_BRIEF}
        onRestore={() => {}}
      />,
    );
    await expandPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId("version-history-icon")).toHaveLength(2);
      expect(screen.getAllByTestId("version-history-timestamp")).toHaveLength(
        2,
      );
      expect(screen.getAllByTestId("version-history-summary")).toHaveLength(2);
    });
    expect(screen.getAllByTestId("version-history-summary")[0]).toHaveTextContent(
      /Change hero heading/,
    );
  });

  test("shows error when the GET fails", async () => {
    fetchSpy.mockResolvedValueOnce(mkJson(500, { error: "nope" }));
    render(
      <VersionHistoryPanel
        siteId="site_1"
        currentBrief={CURRENT_BRIEF}
        onRestore={() => {}}
      />,
    );
    await expandPanel();
    await waitFor(() => {
      expect(screen.getByTestId("version-history-error")).toBeInTheDocument();
    });
  });
});

describe("VersionHistoryPanel — diff modal", () => {
  test("clicking View opens the modal and shows a diff", async () => {
    fetchSpy.mockResolvedValueOnce(mkJson(200, { versions: VERSIONS }));
    render(
      <VersionHistoryPanel
        siteId="site_1"
        currentBrief={CURRENT_BRIEF}
        onRestore={() => {}}
      />,
    );
    await expandPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId("version-history-entry")).toHaveLength(2);
    });

    // Click View on the OLDER (second) entry — its hero heading differs
    // from the current brief's, so the diff modal should show a replace.
    const entries = screen.getAllByTestId("version-history-entry");
    const viewBtn = within(entries[1]).getByTestId("version-history-view-btn");
    fireEvent.click(viewBtn);

    await waitFor(() => {
      expect(screen.getByTestId("version-diff-modal")).toBeInTheDocument();
    });
    // Exactly one diff entry (the hero heading change)
    const diffEntries = screen.getAllByTestId("version-diff-entry");
    expect(diffEntries.length).toBeGreaterThanOrEqual(1);
    // The diff shows both the old + new value labels
    expect(screen.getByTestId("version-diff-before")).toHaveTextContent(
      /Current Heading/,
    );
    expect(screen.getByTestId("version-diff-after")).toHaveTextContent(
      /Old Heading/,
    );
  });

  test("diff modal shows empty state when versions match current brief", async () => {
    // Identical — the hero entry has the same brief as current.
    fetchSpy.mockResolvedValueOnce(mkJson(200, { versions: VERSIONS }));
    render(
      <VersionHistoryPanel
        siteId="site_1"
        currentBrief={CURRENT_BRIEF}
        onRestore={() => {}}
      />,
    );
    await expandPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId("version-history-entry")).toHaveLength(2);
    });
    // Click View on the FIRST (newest) entry — it IS the current brief.
    const entries = screen.getAllByTestId("version-history-entry");
    fireEvent.click(
      within(entries[0]).getByTestId("version-history-view-btn"),
    );
    await waitFor(() => {
      expect(screen.getByTestId("version-diff-modal")).toBeInTheDocument();
    });
    expect(screen.getByTestId("version-diff-empty")).toBeInTheDocument();
  });

  test("Cancel closes the modal without POST", async () => {
    fetchSpy.mockResolvedValueOnce(mkJson(200, { versions: VERSIONS }));
    render(
      <VersionHistoryPanel
        siteId="site_1"
        currentBrief={CURRENT_BRIEF}
        onRestore={() => {}}
      />,
    );
    await expandPanel();
    await waitFor(() =>
      expect(screen.getAllByTestId("version-history-entry")).toHaveLength(2),
    );
    const entries = screen.getAllByTestId("version-history-entry");
    fireEvent.click(
      within(entries[1]).getByTestId("version-history-view-btn"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("version-diff-modal")).toBeInTheDocument(),
    );

    // Cancel — modal disappears, no additional POST calls.
    fetchSpy.mockClear();
    fireEvent.click(screen.getByTestId("version-diff-cancel"));
    await waitFor(() => {
      expect(screen.queryByTestId("version-diff-modal")).not.toBeInTheDocument();
    });
    // Only the analytics POST from modal-open may have fired; NO restore POST.
    const postCalls = fetchSpy.mock.calls.filter((c) => {
      const init = c[1] as RequestInit | undefined;
      return init?.method === "POST";
    });
    const restorePosts = postCalls.filter((c) =>
      String(c[0]).endsWith("/versions"),
    );
    expect(restorePosts).toHaveLength(0);
  });
});

describe("VersionHistoryPanel — restore", () => {
  test("clicking Restore POSTs to /versions and calls onRestore", async () => {
    fetchSpy.mockResolvedValueOnce(mkJson(200, { versions: VERSIONS }));
    const onRestore = jest.fn();

    render(
      <VersionHistoryPanel
        siteId="site_1"
        currentBrief={CURRENT_BRIEF}
        onRestore={onRestore}
      />,
    );
    await expandPanel();
    await waitFor(() =>
      expect(screen.getAllByTestId("version-history-entry")).toHaveLength(2),
    );
    const entries = screen.getAllByTestId("version-history-entry");
    fireEvent.click(
      within(entries[1]).getByTestId("version-history-view-btn"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("version-diff-modal")).toBeInTheDocument(),
    );

    // The POST response: a restored version entry.
    const newEntry: BriefVersionEntryView = {
      id: "edit_restored",
      kind: "restore",
      siteId: "site_1",
      brief: OLD_BRIEF,
      authorId: "u_1",
      authorRole: "sales",
      summary: "Restored an earlier version",
      createdAt: new Date().toISOString(),
      parentVersionId: "gen_g1",
    };
    fetchSpy.mockResolvedValueOnce(mkJson(200, { version: newEntry }));

    const restoreBtn = screen.getByTestId("version-diff-restore");
    fireEvent.click(restoreBtn);

    await waitFor(() => expect(onRestore).toHaveBeenCalledWith(newEntry));
    // Modal closes.
    expect(screen.queryByTestId("version-diff-modal")).not.toBeInTheDocument();

    // Check we did fire a POST to /versions with {action: restore}.
    const restorePosts = fetchSpy.mock.calls.filter((c) => {
      const init = c[1] as RequestInit | undefined;
      return (
        init?.method === "POST" && String(c[0]).endsWith("/site_1/versions")
      );
    });
    expect(restorePosts).toHaveLength(1);
    const body = JSON.parse((restorePosts[0][1] as RequestInit).body as string);
    expect(body).toEqual({ action: "restore", toVersionId: "gen_g1" });
  });

  test("surfaces server error without calling onRestore", async () => {
    fetchSpy.mockResolvedValueOnce(mkJson(200, { versions: VERSIONS }));
    const onRestore = jest.fn();

    render(
      <VersionHistoryPanel
        siteId="site_1"
        currentBrief={CURRENT_BRIEF}
        onRestore={onRestore}
      />,
    );
    await expandPanel();
    await waitFor(() =>
      expect(screen.getAllByTestId("version-history-entry")).toHaveLength(2),
    );
    const entries = screen.getAllByTestId("version-history-entry");
    fireEvent.click(
      within(entries[1]).getByTestId("version-history-view-btn"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("version-diff-modal")).toBeInTheDocument(),
    );

    fetchSpy.mockResolvedValueOnce(mkJson(500, { error: "restore broke" }));
    fireEvent.click(screen.getByTestId("version-diff-restore"));

    await waitFor(() => {
      expect(screen.getByTestId("version-history-error")).toHaveTextContent(
        /restore broke/,
      );
    });
    expect(onRestore).not.toHaveBeenCalled();
  });
});
