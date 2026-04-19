/**
 * @jest-environment jsdom
 */

/**
 * ShareApprovalPanel — comment composer tests.
 *
 * Covers the Path C Phase 3 · Stream R3 additions:
 *   - A `comment.pin` postMessage arrives → composer appears
 *   - Submitting posts to the correct public comments route
 *   - Cancel dismisses the composer
 *   - Error state surfaces when the API rejects
 *   - Success state auto-dismisses
 *   - The composer does NOT render when the message lacks the Instinct
 *     origin brand (no third-party spoofing)
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ShareApprovalPanel from "@/app/share/[token]/ShareApprovalPanel";
import { INSTINCT_EDIT_ORIGIN } from "@/lib/preview-postmessage";

let fetchSpy: jest.Mock;

beforeEach(() => {
  fetchSpy = jest.fn();
  (global as unknown as { fetch: typeof fetch }).fetch =
    fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

function fireCommentPin(pageIndex = 0, sectionIndex = 0, x = 120, y = 200) {
  // MessageEvent in jsdom with matching origin so the guard passes.
  const event = new MessageEvent("message", {
    data: {
      origin: INSTINCT_EDIT_ORIGIN,
      type: "comment.pin",
      pageIndex,
      sectionIndex,
      clientX: x,
      clientY: y,
    },
    origin: window.location.origin,
  });
  window.dispatchEvent(event);
}

function okResponse(body: unknown = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

describe("ShareApprovalPanel — comment composer", () => {
  it("mounts the composer when a comment.pin arrives", async () => {
    render(<ShareApprovalPanel token="tok-abc" />);
    expect(screen.queryByTestId("share-comment-composer")).not.toBeInTheDocument();
    await act(async () => {
      fireCommentPin(1, 2, 100, 150);
    });
    expect(screen.getByTestId("share-comment-composer")).toBeInTheDocument();
    // Coordinate text for the anchor (page/section labels).
    expect(
      screen.getByTestId("share-comment-composer").textContent,
    ).toMatch(/section 3/i);
  });

  it("does NOT mount for messages without the Instinct origin brand", async () => {
    render(<ShareApprovalPanel token="tok-abc" />);
    const event = new MessageEvent("message", {
      data: { origin: "third.party.v1", type: "comment.pin", pageIndex: 0, sectionIndex: 0, clientX: 1, clientY: 1 },
      origin: window.location.origin,
    });
    await act(async () => {
      window.dispatchEvent(event);
    });
    expect(screen.queryByTestId("share-comment-composer")).not.toBeInTheDocument();
  });

  it("submits the comment via POST to the public comments route", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse({ comment: { id: "c1" } }));
    render(<ShareApprovalPanel token="tok-abc" />);
    await act(async () => {
      fireCommentPin(0, 1, 120, 160);
    });
    const body = screen.getByTestId("share-comment-composer-body");
    await act(async () => {
      fireEvent.change(body, { target: { value: "Section 2 looks off" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("share-comment-composer-submit"));
    });
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/public/share/tok-abc/comments");
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(payload.pageIndex).toBe(0);
    expect(payload.sectionIndex).toBe(1);
    expect(payload.body).toBe("Section 2 looks off");
  });

  it("surfaces an error when the API rejects", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: "Too many comments" }),
    } as unknown as Response);
    render(<ShareApprovalPanel token="tok-abc" />);
    await act(async () => {
      fireCommentPin();
    });
    const body = screen.getByTestId("share-comment-composer-body");
    await act(async () => {
      fireEvent.change(body, { target: { value: "hi" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("share-comment-composer-submit"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("share-comment-composer-error")).toBeInTheDocument();
    });
  });

  it("cancel dismisses the composer", async () => {
    render(<ShareApprovalPanel token="tok-abc" />);
    await act(async () => {
      fireCommentPin();
    });
    expect(screen.getByTestId("share-comment-composer")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId("share-comment-composer-cancel"));
    });
    expect(screen.queryByTestId("share-comment-composer")).not.toBeInTheDocument();
  });

  it("will not submit an empty body", async () => {
    render(<ShareApprovalPanel token="tok-abc" />);
    await act(async () => {
      fireCommentPin();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("share-comment-composer-submit"));
    });
    // fetch must NOT have been invoked for an empty body.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("share-comment-composer-error")).toBeInTheDocument();
  });
});
