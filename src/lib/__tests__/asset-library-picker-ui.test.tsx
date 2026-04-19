/**
 * @jest-environment jsdom
 */

/**
 * AssetLibraryPicker — UI tests.
 *
 * Mocks global.fetch (through fetchWithRefresh) so no real API calls
 * fire. Verifies empty state, grid render with N assets, onPick wiring,
 * kind filter, upload button plumbing, and delete-with-confirm.
 */

import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import AssetLibraryPicker, {
  type ClientAssetView,
} from "@/components/sites/AssetLibraryPicker";

let fetchSpy: jest.Mock;

beforeEach(() => {
  fetchSpy = jest.fn();
  (global as unknown as { fetch: typeof fetch }).fetch =
    fetchSpy as unknown as typeof fetch;
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

function mkAsset(overrides: Partial<ClientAssetView> = {}): ClientAssetView {
  return {
    id: "a_1",
    clientSlug: "acme",
    assetKind: "logo",
    filename: "logo.png",
    url: "/api/clients/acme/assets/a_1/raw",
    mime: "image/png",
    sizeBytes: 1234,
    sha256: "hash_1",
    altText: null,
    useCount: 1,
    lastUsedAt: null,
    uploadedAt: "2026-04-19T00:00:00Z",
    ...overrides,
  };
}

describe("AssetLibraryPicker", () => {
  it("shows empty state when no assets", async () => {
    fetchSpy.mockResolvedValueOnce(mkResponse(200, { assets: [] }));
    const onPick = jest.fn();
    await act(async () => {
      render(<AssetLibraryPicker clientSlug="acme" onPick={onPick} />);
    });
    await waitFor(() => {
      expect(screen.getByTestId("asset-empty-state")).toBeInTheDocument();
    });
    expect(screen.getByTestId("asset-empty-state")).toHaveTextContent(
      /No assets yet/i,
    );
  });

  it("renders N asset cards in the grid", async () => {
    fetchSpy.mockResolvedValueOnce(
      mkResponse(200, {
        assets: [
          mkAsset({ id: "a_1", filename: "logo.png", useCount: 5 }),
          mkAsset({ id: "a_2", filename: "hero.jpg", assetKind: "photo" }),
          mkAsset({ id: "a_3", filename: "icon.svg", assetKind: "icon" }),
        ],
      }),
    );
    await act(async () => {
      render(<AssetLibraryPicker clientSlug="acme" onPick={jest.fn()} />);
    });
    await waitFor(() => {
      expect(screen.getByTestId("asset-grid")).toBeInTheDocument();
    });
    expect(screen.getByTestId("asset-card-a_1")).toBeInTheDocument();
    expect(screen.getByTestId("asset-card-a_2")).toBeInTheDocument();
    expect(screen.getByTestId("asset-card-a_3")).toBeInTheDocument();
    expect(screen.getByTestId("asset-use-count-a_1")).toHaveTextContent(
      /used 5×/i,
    );
  });

  it("clicking an asset calls onPick with the asset object", async () => {
    const asset = mkAsset({ id: "a_42" });
    fetchSpy.mockResolvedValueOnce(mkResponse(200, { assets: [asset] }));
    const onPick = jest.fn();
    await act(async () => {
      render(<AssetLibraryPicker clientSlug="acme" onPick={onPick} />);
    });
    await waitFor(() => {
      expect(screen.getByTestId("asset-pick-a_42")).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("asset-pick-a_42"));
    });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toMatchObject({ id: "a_42" });
  });

  it("kind filter narrows the visible list (re-fetches with ?kind=)", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        mkResponse(200, {
          assets: [mkAsset({ id: "a_1", assetKind: "logo" })],
        }),
      )
      .mockResolvedValueOnce(
        mkResponse(200, {
          assets: [mkAsset({ id: "a_2", assetKind: "photo", filename: "hero.jpg" })],
        }),
      );
    await act(async () => {
      render(<AssetLibraryPicker clientSlug="acme" onPick={jest.fn()} />);
    });
    await waitFor(() => {
      expect(screen.getByTestId("asset-card-a_1")).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId("asset-kind-filter"), {
        target: { value: "photo" },
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId("asset-card-a_2")).toBeInTheDocument();
    });
    // Second call should include ?kind=photo in the URL
    const lastCallUrl = String(fetchSpy.mock.calls[1][0]);
    expect(lastCallUrl).toContain("kind=photo");
  });

  it("search filter narrows by filename on the client side", async () => {
    fetchSpy.mockResolvedValueOnce(
      mkResponse(200, {
        assets: [
          mkAsset({ id: "a_1", filename: "logo.png" }),
          mkAsset({ id: "a_2", filename: "hero.jpg" }),
        ],
      }),
    );
    await act(async () => {
      render(<AssetLibraryPicker clientSlug="acme" onPick={jest.fn()} />);
    });
    await waitFor(() => {
      expect(screen.getByTestId("asset-card-a_1")).toBeInTheDocument();
      expect(screen.getByTestId("asset-card-a_2")).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId("asset-search"), {
        target: { value: "hero" },
      });
    });
    expect(screen.queryByTestId("asset-card-a_1")).not.toBeInTheDocument();
    expect(screen.getByTestId("asset-card-a_2")).toBeInTheDocument();
  });

  it("upload input presence + kind selector exposed for file-picker trigger", async () => {
    fetchSpy.mockResolvedValueOnce(mkResponse(200, { assets: [] }));
    await act(async () => {
      render(<AssetLibraryPicker clientSlug="acme" onPick={jest.fn()} />);
    });
    await waitFor(() => {
      expect(screen.getByTestId("asset-upload-input")).toBeInTheDocument();
    });
    // The label is the visible clickable affordance; confirm it renders.
    expect(screen.getByTestId("asset-upload-label")).toBeInTheDocument();
    expect(screen.getByTestId("asset-upload-kind")).toBeInTheDocument();
  });

  it("delete fires DELETE + removes card when confirmed", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        mkResponse(200, { assets: [mkAsset({ id: "a_doomed" })] }),
      )
      .mockResolvedValueOnce(mkResponse(200, { ok: true }));
    await act(async () => {
      render(<AssetLibraryPicker clientSlug="acme" onPick={jest.fn()} />);
    });
    await waitFor(() => {
      expect(screen.getByTestId("asset-card-a_doomed")).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("asset-delete-a_doomed"));
    });
    await waitFor(() => {
      expect(screen.queryByTestId("asset-card-a_doomed")).not.toBeInTheDocument();
    });
    const deleteCall = fetchSpy.mock.calls.find(
      (call) => (call[1] as { method?: string })?.method === "DELETE",
    );
    expect(deleteCall).toBeTruthy();
    expect(String(deleteCall![0])).toContain(
      "/api/clients/acme/assets/a_doomed",
    );
  });

  it("surfaces server error on load", async () => {
    fetchSpy.mockResolvedValueOnce(mkResponse(500, { error: "db down" }));
    await act(async () => {
      render(<AssetLibraryPicker clientSlug="acme" onPick={jest.fn()} />);
    });
    await waitFor(() => {
      expect(screen.getByTestId("asset-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("asset-error")).toHaveTextContent(/db down/i);
  });
});
