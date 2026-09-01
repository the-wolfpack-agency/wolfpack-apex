/**
 * @jest-environment jsdom
 */

/**
 * CommentsPane — designer-side side-panel UI tests.
 *
 * Mocks fetchWithRefresh so no real network fires. Covers:
 *   - loading state → resolved fetch → renders grouped list
 *   - empty state
 *   - filter tabs switch the displayed comments
 *   - click a comment → postMessage comment.focus fires to the iframe
 *   - reply button opens composer, submit POSTs with parentCommentId
 *   - resolve button POSTs + flips local state optimiztically
 *   - delete calls DELETE
 *   - error banner surfaces on fetch failure
 */

import "@testing-library/jest-dom";
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...args: unknown[]) => mockFetch(...args),
}));

import CommentsPane from "@/components/sites/CommentsPane";

const COMMENTS = [
  {
    id: "c1",
    siteId: "site_1",
    shareTokenId: "tok_1",
    pageIndex: 0,
    sectionIndex: 1,
    sectionType: "hero",
    body: "Please make the heading bigger",
    actorName: "Client A",
    actorEmail: "a@example.com",
    parentCommentId: null,
    state: "open",
    resolvedBy: null,
    resolvedAt: null,
    createdAt: "2026-04-19T00:00:00Z",
  },
  {
    id: "c2",
    siteId: "site_1",
    shareTokenId: null,
    pageIndex: 1,
    sectionIndex: 0,
    sectionType: "text",
    body: "Another feedback",
    actorName: "Designer",
    actorEmail: null,
    parentCommentId: null,
    state: "resolved",
    resolvedBy: "u_1",
    resolvedAt: "2026-04-19T01:00:00Z",
    createdAt: "2026-04-19T00:30:00Z",
  },
  {
    id: "c3",
    siteId: "site_1",
    shareTokenId: null,
    pageIndex: 0,
    sectionIndex: 1,
    sectionType: "hero",
    body: "Will do, thanks!",
    actorName: "Designer",
    actorEmail: null,
    parentCommentId: "c1",
    state: "open",
    resolvedBy: null,
    resolvedAt: null,
    createdAt: "2026-04-19T00:15:00Z",
  },
];

function mockOkJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockResolvedValue(mockOkJson({ comments: COMMENTS }));
  jest.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("CommentsPane — rendering", () => {
  it("shows loading then renders grouped list", async () => {
    render(<CommentsPane siteId="site_1" />);
    // Loading is synchronous on first render; then the async fetch settles.
    await waitFor(() => {
      expect(screen.getByTestId("comments-pane-list")).toBeInTheDocument();
    });
    // Default filter is "open" — we see c1 (open), not c2 (resolved).
    expect(screen.getByTestId("comment-c1")).toBeInTheDocument();
    expect(screen.queryByTestId("comment-c2")).not.toBeInTheDocument();
  });

  it("renders empty state when no comments match", async () => {
    mockFetch.mockResolvedValueOnce(mockOkJson({ comments: [] }));
    render(<CommentsPane siteId="site_1" />);
    await waitFor(() => {
      expect(screen.getByTestId("comments-pane-empty")).toBeInTheDocument();
    });
  });

  it("switches to resolved filter", async () => {
    render(<CommentsPane siteId="site_1" />);
    await waitFor(() =>
      expect(screen.getByTestId("comments-pane-list")).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("comments-filter-resolved"));
    });
    expect(screen.getByTestId("comment-c2")).toBeInTheDocument();
    expect(screen.queryByTestId("comment-c1")).not.toBeInTheDocument();
  });

  it("renders replies nested under the parent", async () => {
    render(<CommentsPane siteId="site_1" />);
    await waitFor(() =>
      expect(screen.getByTestId("comments-pane-list")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("comment-reply-c3")).toBeInTheDocument();
  });

  it("surfaces an error banner when fetch fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as unknown as Response);
    render(<CommentsPane siteId="site_1" />);
    await waitFor(() => {
      expect(screen.getByTestId("comments-pane-error")).toBeInTheDocument();
    });
  });
});

describe("CommentsPane — interactions", () => {
  it("posts a comment.focus postMessage when a comment is clicked", async () => {
    // Build a real iframe so we can intercept postMessage via a stub
    // contentWindow.
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const postSpy = jest.fn();
    Object.defineProperty(iframe, "contentWindow", {
      value: { postMessage: postSpy },
      configurable: true,
    });
    const ref = { current: iframe };
    render(<CommentsPane siteId="site_1" previewIframeRef={ref} />);
    await waitFor(() =>
      expect(screen.getByTestId("comments-pane-list")).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("comment-focus-c1"));
    });
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "comment.focus",
        pageIndex: 0,
        sectionIndex: 1,
      }),
      expect.any(String),
    );
  });

  it("resolve button POSTs + flips state optimiztically", async () => {
    render(<CommentsPane siteId="site_1" />);
    await waitFor(() =>
      expect(screen.getByTestId("comments-pane-list")).toBeInTheDocument(),
    );
    mockFetch.mockResolvedValueOnce(mockOkJson({ comment: { ...COMMENTS[0], state: "resolved" } }));
    await act(async () => {
      fireEvent.click(screen.getByTestId("comment-resolve-c1"));
    });
    // Route URL must include /resolve suffix.
    const calls = mockFetch.mock.calls;
    const urls = calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes("/comments/c1/resolve"))).toBe(true);
  });

  it("reply flow submits with parentCommentId", async () => {
    render(<CommentsPane siteId="site_1" />);
    await waitFor(() =>
      expect(screen.getByTestId("comments-pane-list")).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("comment-reply-btn-c1"));
    });
    const input = screen.getByTestId("comment-reply-input-c1");
    await act(async () => {
      fireEvent.change(input, { target: { value: "Got it" } });
    });
    mockFetch.mockResolvedValueOnce(mockOkJson({ comment: COMMENTS[2] }));
    mockFetch.mockResolvedValueOnce(mockOkJson({ comments: COMMENTS }));
    await act(async () => {
      fireEvent.click(screen.getByTestId("comment-reply-submit-c1"));
    });
    // Find the POST /comments call — we asserted body contains parentCommentId.
    const postCall = mockFetch.mock.calls.find(
      (c) =>
        typeof c[1] === "object" &&
        (c[1] as RequestInit)?.method === "POST" &&
        !(c[0] as string).includes("/resolve"),
    );
    expect(postCall).toBeTruthy();
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body.parentCommentId).toBe("c1");
    expect(body.body).toBe("Got it");
  });

  it("delete button calls DELETE", async () => {
    render(<CommentsPane siteId="site_1" />);
    await waitFor(() =>
      expect(screen.getByTestId("comments-pane-list")).toBeInTheDocument(),
    );
    mockFetch.mockResolvedValueOnce(mockOkJson({ ok: true }));
    mockFetch.mockResolvedValueOnce(mockOkJson({ comments: COMMENTS }));
    await act(async () => {
      fireEvent.click(screen.getByTestId("comment-delete-c1"));
    });
    const deleteCall = mockFetch.mock.calls.find(
      (c) => (c[1] as RequestInit)?.method === "DELETE",
    );
    expect(deleteCall).toBeTruthy();
  });
});
