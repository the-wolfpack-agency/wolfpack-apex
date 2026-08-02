/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

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
});

/**
 * Build a URL→response map so tests don't depend on call order. React 19
 * strict mode can double-invoke effects under jsdom; mockResolvedValueOnce
 * would be consumed twice.
 */
/** Real fetch sets `ok` for 2xx ONLY, never for a 3xx. These fakes said
 *  `status < 400`, so a redirect would have read as success. No test here
 *  currently uses a 3xx, so it was a trap rather than a live bug — corrected
 *  alongside the same mistake found in the compliance collector (PR #224). */
function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

function mockByUrl(map: Record<string, { status?: number; body?: unknown }>) {
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).toString?.() ?? String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${url.split("?")[0]}`;
    const hit = map[key] ?? map[url] ?? { status: 200, body: {} };
    return {
      ok: isOk(hit.status ?? 200),
      status: hit.status ?? 200,
      json: async () => hit.body ?? {},
    };
  });
}

async function renderPicker(props: Partial<{ open: boolean; onCreated: () => void }> = {}) {
  const Picker = (await import("@/components/onenote/NotebookPicker")).default;
  const onClose = jest.fn();
  const onCreated = props.onCreated ?? jest.fn();
  const utils = render(
    <Picker open={props.open ?? true} onClose={onClose} onCreated={onCreated} />,
  );
  return { ...utils, onClose, onCreated };
}

describe("<NotebookPicker />", () => {
  test("renders nothing when open=false", async () => {
    mockByUrl({});
    await renderPicker({ open: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("loads notebooks on open and lets user pick section + create page", async () => {
    mockByUrl({
      "GET /api/onenote/notebooks": { body: { notebooks: [{ id: "n1", displayName: "Work" }] } },
      "GET /api/onenote/sections": { body: { sections: [{ id: "s1", displayName: "Notes" }] } },
      "POST /api/onenote/pages": { status: 201, body: { page: { id: "p1", webUrl: "https://x" } } },
    });

    const onCreated = jest.fn();
    await renderPicker({ onCreated });

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    // Wait for notebooks to load
    await waitFor(() => {
      expect((screen.getByLabelText("Notebook") as HTMLSelectElement).options.length).toBeGreaterThan(1);
    });

    // Select notebook
    const notebookSelect = screen.getByLabelText("Notebook") as HTMLSelectElement;
    fireEvent.change(notebookSelect, { target: { value: "n1" } });

    // Wait for sections to load
    await waitFor(() => {
      expect((screen.getByLabelText("Section") as HTMLSelectElement).options.length).toBeGreaterThan(1);
    });

    // Select section
    const sectionSelect = screen.getByLabelText("Section") as HTMLSelectElement;
    fireEvent.change(sectionSelect, { target: { value: "s1" } });

    // Fill title
    const titleInput = screen.getByLabelText("Title");
    fireEvent.change(titleInput, { target: { value: "New page" } });

    // Fill body
    const bodyInput = screen.getByLabelText("Body");
    fireEvent.change(bodyInput, { target: { value: "<p>Body</p>" } });

    // Click create
    const createBtn = screen.getByText(/Create page/);
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith({ id: "p1", webUrl: "https://x" });
    });

    // POST body
    const postCall = fetchMock.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("/api/onenote/pages") && c[1]?.method === "POST",
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse((postCall![1] as any).body);
    expect(body).toEqual({ sectionId: "s1", title: "New page", html: "<p>Body</p>" });
  });

  test("shows error message when create fails", async () => {
    mockByUrl({
      "GET /api/onenote/notebooks": { body: { notebooks: [{ id: "n1", displayName: "Work" }] } },
      "GET /api/onenote/sections": { body: { sections: [{ id: "s1", displayName: "Notes" }] } },
      "POST /api/onenote/pages": { status: 403, body: { error: "scope_missing" } },
    });

    await renderPicker();

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect((screen.getByLabelText("Notebook") as HTMLSelectElement).options.length).toBeGreaterThan(1);
    });

    fireEvent.change(screen.getByLabelText("Notebook"), { target: { value: "n1" } });
    await waitFor(() => {
      expect((screen.getByLabelText("Section") as HTMLSelectElement).options.length).toBeGreaterThan(1);
    });
    fireEvent.change(screen.getByLabelText("Section"), { target: { value: "s1" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "x" } });
    fireEvent.click(screen.getByText(/Create page/));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });
});
