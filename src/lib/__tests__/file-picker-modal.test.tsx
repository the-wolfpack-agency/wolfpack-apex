/**
 * @jest-environment jsdom
 */

/**
 * FilePickerModal — render + click + pick + upload smoke.
 */

import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

const fetchMockFP = jest.fn();

beforeAll(() => {
  global.fetch = fetchMockFP as unknown as typeof fetch;
  Object.defineProperty(window, "localStorage", {
    value: {
      _store: { instinct_token: "t" } as Record<string, string>,
      getItem(this: any, k: string) { return this._store[k] ?? null; },
      setItem(this: any, k: string, v: string) { this._store[k] = v; },
      removeItem(this: any, k: string) { delete this._store[k]; },
      clear(this: any) { this._store = {}; },
    },
    writable: true,
  });
});

beforeEach(() => {
  fetchMockFP.mockReset();
});

function mockFetch(map: Record<string, { json?: unknown; status?: number }>) {
  fetchMockFP.mockImplementation(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${url.split("?")[0]}`;
    const entry = map[key] ?? map[url] ?? { json: { items: [] }, status: 200 };
    return {
      ok: (entry.status ?? 200) < 400,
      status: entry.status ?? 200,
      json: async () => entry.json ?? {},
    };
  });
}

describe("<FilePickerModal />", () => {
  test("does not render when closed", async () => {
    const FilePickerModal = (await import("@/components/files/FilePickerModal")).default;
    const { queryByRole } = render(
      <FilePickerModal open={false} onClose={() => {}} onPick={() => {}} />,
    );
    expect(queryByRole("dialog")).toBeNull();
  });

  test("lists items from /api/files", async () => {
    mockFetch({
      "GET /api/files": {
        json: {
          items: [
            { id: "1", msDriveItemId: "a", name: "doc.txt", isFolder: false, sizeBytes: 12, modifiedAt: null, parentPath: null, mimeType: "text/plain", webUrl: "u" },
            { id: "2", msDriveItemId: "b", name: "Folder", isFolder: true, sizeBytes: null, modifiedAt: null, parentPath: null, mimeType: null, webUrl: "u" },
          ],
        },
      },
    });
    const FilePickerModal = (await import("@/components/files/FilePickerModal")).default;
    render(<FilePickerModal open={true} onClose={() => {}} onPick={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText("doc.txt")).toBeInTheDocument();
      expect(screen.getByText("Folder")).toBeInTheDocument();
    });
  });

  test("clicking a file fires onPick", async () => {
    mockFetch({
      "GET /api/files": {
        json: { items: [{ id: "1", msDriveItemId: "a", name: "doc.txt", isFolder: false, sizeBytes: 12, modifiedAt: null, parentPath: null, mimeType: "text/plain", webUrl: "u" }] },
      },
    });
    const onPick = jest.fn();
    const FilePickerModal = (await import("@/components/files/FilePickerModal")).default;
    render(<FilePickerModal open={true} onClose={() => {}} onPick={onPick} />);
    await waitFor(() => screen.getByText("doc.txt"));
    fireEvent.click(screen.getByText("doc.txt"));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ msDriveItemId: "a" }));
  });

  test("403 response shows scope error", async () => {
    mockFetch({
      "GET /api/files": { status: 403, json: { error: "scope_missing", scope: "Files.ReadWrite" } },
    });
    const FilePickerModal = (await import("@/components/files/FilePickerModal")).default;
    render(<FilePickerModal open={true} onClose={() => {}} onPick={() => {}} />);
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("Files.ReadWrite");
    });
  });

  test("clicking a folder updates breadcrumbs", async () => {
    mockFetch({
      "GET /api/files": {
        json: { items: [{ id: "1", msDriveItemId: "folder-a", name: "MyFolder", isFolder: true, sizeBytes: null, modifiedAt: null, parentPath: null, mimeType: null, webUrl: null }] },
      },
    });
    const FilePickerModal = (await import("@/components/files/FilePickerModal")).default;
    render(<FilePickerModal open={true} onClose={() => {}} onPick={() => {}} />);
    await waitFor(() => screen.getByText("MyFolder"));
    fireEvent.click(screen.getByText("MyFolder"));
    await waitFor(() => {
      // Breadcrumb now includes the folder name as a clickable button.
      const crumb = screen.getByRole("button", { name: "MyFolder" });
      expect(crumb).toBeInTheDocument();
    });
  });
});
