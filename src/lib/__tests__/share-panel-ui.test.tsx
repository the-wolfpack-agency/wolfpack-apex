/**
 * @jest-environment jsdom
 */

/**
 * SharePanel — UI tests.
 *
 * Mocks global.fetch (consumed by fetchWithRefresh) so no real /api
 * calls fire. Verifies:
 *   - empty state when no tokens issued
 *   - an active token row is rendered with expiry + access count
 *   - revoke button calls DELETE with the right tokenId
 *   - generate-link calls POST, writes to clipboard, surfaces "Copied"
 *   - latest-approval chip reflects the state returned by GET
 *   - disabled state when previewUrl is null
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SharePanel from "@/components/sites/SharePanel";

let fetchSpy: jest.Mock;

beforeEach(() => {
  fetchSpy = jest.fn();
  (global as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;
  window.localStorage.setItem("instinct_token", "test-token");
  jest.spyOn(window, "confirm").mockReturnValue(true);
  Object.assign(navigator, {
    clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  window.localStorage.clear();
  jest.restoreAllMocks();
});

function mkResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ "content-type": "application/json" }),
  } as unknown as Response;
}

describe("SharePanel", () => {
  it("shows the empty state + no-preview hint when disabled", async () => {
    fetchSpy.mockResolvedValueOnce(
      mkResponse(200, { tokens: [], latestApproval: null }),
    );
    await act(async () => {
      render(<SharePanel siteId="site_1" previewUrl={null} />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("share-empty-state")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("no-preview-hint")).toBeInTheDocument();
    expect(screen.getByTestId("generate-share-link")).toBeDisabled();
  });

  it("renders an active token row + its metadata", async () => {
    fetchSpy.mockResolvedValueOnce(
      mkResponse(200, {
        tokens: [
          {
            id: "t1",
            nonce: "n1",
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 86400_000 * 5).toISOString(),
            revoked_at: null,
            last_accessed_at: null,
            access_count: 2,
          },
        ],
        latestApproval: null,
      }),
    );
    await act(async () => {
      render(<SharePanel siteId="site_1" previewUrl="https://example.com" />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("share-token-row-t1")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("share-token-row-t1")).toHaveTextContent(/2 views/);
    expect(screen.getByTestId("revoke-token-t1")).toBeInTheDocument();
  });

  it("reflects the latest approval state in the chip", async () => {
    fetchSpy.mockResolvedValueOnce(
      mkResponse(200, {
        tokens: [],
        latestApproval: {
          state: "approved",
          actorName: "Client",
          actorEmail: null,
          comment: "ship it",
          createdAt: new Date().toISOString(),
          viaShareToken: true,
        },
      }),
    );
    await act(async () => {
      render(<SharePanel siteId="site_1" previewUrl="https://example.com" />);
    });
    await waitFor(() => {
      expect(screen.getByTestId("approval-state-chip")).toHaveTextContent(
        /Client approved/i,
      );
    });
    expect(screen.getByTestId("latest-approval-comment")).toHaveTextContent(
      /ship it/,
    );
  });

  it("revokes a token when the revoke button is clicked", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        mkResponse(200, {
          tokens: [
            {
              id: "t1",
              nonce: "n1",
              created_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 86400_000 * 5).toISOString(),
              revoked_at: null,
              last_accessed_at: null,
              access_count: 0,
            },
          ],
          latestApproval: null,
        }),
      )
      .mockResolvedValueOnce(mkResponse(200, { ok: true })) // DELETE
      .mockResolvedValueOnce(
        mkResponse(200, { tokens: [], latestApproval: null }),
      ); // reload

    await act(async () => {
      render(<SharePanel siteId="site_1" previewUrl="https://example.com" />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("revoke-token-t1")).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("revoke-token-t1"));
    });
    await waitFor(() => {
      const deleteCall = fetchSpy.mock.calls.find(
        ([url, init]) => init?.method === "DELETE" && String(url).includes("tokenId=t1"),
      );
      expect(deleteCall).toBeTruthy();
    });
  });

  it("generates a share link, writes to clipboard, and shows the flash", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        mkResponse(200, { tokens: [], latestApproval: null }),
      )
      .mockResolvedValueOnce(
        mkResponse(200, {
          token: "payload.sig",
          shareUrl: "/share/payload.sig",
          nonce: "nonce-xxx",
          expiresAt: new Date(Date.now() + 86400_000 * 30).toISOString(),
        }),
      )
      .mockResolvedValueOnce(
        mkResponse(200, { tokens: [], latestApproval: null }),
      );

    await act(async () => {
      render(<SharePanel siteId="site_1" previewUrl="https://example.com" />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("generate-share-link")).toBeEnabled(),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("generate-share-link"));
    });
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining("/share/payload.sig"),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("share-flash")).toHaveTextContent(/Copied/i);
    });
  });

  it("surfaces an error when the list call fails", async () => {
    fetchSpy.mockResolvedValueOnce(mkResponse(500, { error: "boom" }));
    await act(async () => {
      render(<SharePanel siteId="site_1" previewUrl={null} />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("share-error")).toHaveTextContent(/boom/),
    );
  });
});
