/**
 * @jest-environment jsdom
 *
 * /docs page — edit + delete flow for the viewed document.
 *
 * Covers:
 *   - Edit button reveals the inline edit form pre-filled with values
 *   - Save fires PUT /api/docs/[id] via fetchWithRefresh
 *   - Delete confirm-accept fires DELETE /api/docs/[id]
 *   - Delete confirm-cancel skips the network
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...args: unknown[]) => mockFetchWithRefresh(...args),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
  authHeaders: () => ({}),
}));

const DOCS = [
  {
    id: "doc-1",
    title: "Release Notes v1",
    doc_type: "release_notes",
    content: "# Release Notes\n\nAdded edit/delete.",
    format: "markdown",
    generated_from: null,
    generated_by: "u-owner",
    revision: 1,
    tokens_used: 0,
    downloads: 0,
    created_at: new Date().toISOString(),
  },
];

beforeAll(() => {
  Object.defineProperty(window, "localStorage", {
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    writable: true,
  });
});

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockFetchWithRefresh.mockImplementation((url: string, init?: RequestInit) => {
    if (typeof url === "string" && url === "/api/docs" && (!init || !init.method || init.method === "GET")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ documents: DOCS }),
      } as unknown as Response);
    }
    // PUT / DELETE / analytics → benign 200 with refreshed doc
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ ok: true, document: { ...DOCS[0], title: "Edited" } }),
    } as unknown as Response);
  });
});

async function renderPageAndOpen() {
  const mod = await import("@/app/(dashboard)/docs/page");
  const Page = mod.default;
  await act(async () => {
    render(<Page />);
  });
  await waitFor(() => {
    expect(screen.getByText(/Release Notes v1/)).toBeInTheDocument();
  });
  await act(async () => {
    fireEvent.click(screen.getByText(/Release Notes v1/));
  });
  await waitFor(() => {
    expect(screen.getByTestId("doc-edit-btn")).toBeInTheDocument();
  });
}

test("Document detail surfaces Edit + Delete buttons", async () => {
  await renderPageAndOpen();
  expect(screen.getByTestId("doc-edit-btn")).toBeInTheDocument();
  expect(screen.getByTestId("doc-delete-btn")).toBeInTheDocument();
});

test("Edit reveals form; Save fires PUT /api/docs/[id]", async () => {
  await renderPageAndOpen();
  await act(async () => {
    fireEvent.click(screen.getByTestId("doc-edit-btn"));
  });
  const form = await screen.findByTestId("doc-edit-form");
  expect(form).toBeInTheDocument();
  const titleInput = screen.getByLabelText(/edit document title/i) as HTMLInputElement;
  expect(titleInput.value).toBe("Release Notes v1");
  await act(async () => {
    fireEvent.change(titleInput, { target: { value: "Release Notes v2" } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
  });
  await waitFor(() => {
    const call = mockFetchWithRefresh.mock.calls.find(
      (c) => c[1]?.method === "PUT" && c[0] === "/api/docs/doc-1",
    );
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.title).toBe("Release Notes v2");
  });
});

test("Delete confirm-cancel skips the network", async () => {
  await renderPageAndOpen();
  const spy = jest.spyOn(window, "confirm").mockReturnValue(false);
  try {
    await act(async () => {
      fireEvent.click(screen.getByTestId("doc-delete-btn"));
    });
    expect(spy).toHaveBeenCalled();
    await Promise.resolve();
    const call = mockFetchWithRefresh.mock.calls.find(
      (c) => c[1]?.method === "DELETE",
    );
    expect(call).toBeUndefined();
  } finally {
    spy.mockRestore();
  }
});

test("Delete confirm-accept fires DELETE /api/docs/[id]", async () => {
  await renderPageAndOpen();
  const spy = jest.spyOn(window, "confirm").mockReturnValue(true);
  try {
    await act(async () => {
      fireEvent.click(screen.getByTestId("doc-delete-btn"));
    });
    await waitFor(() => {
      const call = mockFetchWithRefresh.mock.calls.find(
        (c) => c[1]?.method === "DELETE" && c[0] === "/api/docs/doc-1",
      );
      expect(call).toBeDefined();
    });
  } finally {
    spy.mockRestore();
  }
});
