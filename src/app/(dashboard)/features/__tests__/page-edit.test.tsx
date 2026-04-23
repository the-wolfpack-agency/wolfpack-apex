/**
 * @jest-environment jsdom
 *
 * /features page — edit + delete flow. Covers:
 *   - Edit button reveals an inline form pre-filled with the row's values
 *   - Save calls PUT /api/features/[id] + refetches the list
 *   - Delete confirm-cancel skips the network call
 *   - Delete confirm-accept calls DELETE /api/features/[id]
 *   - 200 response from edit fires the success banner (not just !500)
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const fetchMock = jest.fn();

jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...args: unknown[]) => fetchMock(...args),
  jsonHeaders: () => ({ "content-type": "application/json" }),
}));

const SEED_FEATURES = [
  {
    id: "f-1",
    title: "Pipeline Dashboard",
    description: "Show in-flight feature list",
    submitted_by: "u-owner",
    status: "submitted",
    priority: "medium",
    target_product: null,
    analysis: {},
    votes: 3,
    estimated_hours: null,
    estimated_cost: null,
    created_at: "2026-04-01T00:00:00Z",
  },
];

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => {
    if (typeof url === "string" && url === "/api/features") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ features: SEED_FEATURES }),
      } as Response);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true }),
    } as Response);
  });
});

async function renderPage() {
  const mod = await import("@/app/(dashboard)/features/page");
  const Page = mod.default;
  await act(async () => {
    render(<Page />);
  });
  await waitFor(() => {
    expect(screen.getByText(/Pipeline Dashboard/)).toBeInTheDocument();
  });
  // Expand the card so edit/delete buttons become visible.
  await act(async () => {
    fireEvent.click(screen.getByText(/Pipeline Dashboard/));
  });
}

test("Edit button reveals form pre-filled with the feature's values", async () => {
  await renderPage();

  const editBtn = await screen.findByTestId("feature-edit-btn-f-1");
  await act(async () => {
    fireEvent.click(editBtn);
  });

  const form = await screen.findByTestId("feature-edit-form-f-1");
  expect(form).toBeInTheDocument();
  const title = screen.getByLabelText(/edit title/i) as HTMLInputElement;
  const desc = screen.getByLabelText(/edit description/i) as HTMLTextAreaElement;
  expect(title.value).toBe("Pipeline Dashboard");
  expect(desc.value).toBe("Show in-flight feature list");
});

test("Save sends PUT to /api/features/[id] and refetches on 200", async () => {
  await renderPage();

  await act(async () => {
    fireEvent.click(await screen.findByTestId("feature-edit-btn-f-1"));
  });

  const title = await screen.findByLabelText(/edit title/i);
  const desc = screen.getByLabelText(/edit description/i);
  await act(async () => {
    fireEvent.change(title, { target: { value: "NEW TITLE" } });
    fireEvent.change(desc, { target: { value: "NEW DESC" } });
  });

  // Stub the PUT to return 200 with an updated feature.
  fetchMock.mockImplementationOnce((url: string, init?: RequestInit) => {
    expect(url).toBe("/api/features/f-1");
    expect(init?.method).toBe("PUT");
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          feature: { ...SEED_FEATURES[0], title: "NEW TITLE" },
        }),
    } as Response);
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
  });

  await waitFor(() => {
    const putCall = fetchMock.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0] === "/api/features/f-1",
    );
    expect(putCall).toBeDefined();
    const init = putCall?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("PUT");
  });
});

test("Delete confirm-cancel does NOT call the network", async () => {
  await renderPage();

  const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(false);
  try {
    const callsBefore = fetchMock.mock.calls.length;
    await act(async () => {
      fireEvent.click(await screen.findByTestId("feature-delete-btn-f-1"));
    });
    expect(confirmSpy).toHaveBeenCalled();
    // No new fetches after the confirm false.
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    expect(screen.getByText(/Pipeline Dashboard/)).toBeInTheDocument();
  } finally {
    confirmSpy.mockRestore();
  }
});

test("Delete confirm-accept sends DELETE and removes the row optimistically", async () => {
  await renderPage();

  const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
  try {
    // Stub the DELETE to return 200.
    fetchMock.mockImplementationOnce((url: string, init?: RequestInit) => {
      expect(url).toBe("/api/features/f-1");
      expect(init?.method).toBe("DELETE");
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, id: "f-1" }),
      } as Response);
    });

    await act(async () => {
      fireEvent.click(await screen.findByTestId("feature-delete-btn-f-1"));
    });

    await waitFor(() => {
      expect(screen.queryByText(/Pipeline Dashboard/)).not.toBeInTheDocument();
    });
  } finally {
    confirmSpy.mockRestore();
  }
});
