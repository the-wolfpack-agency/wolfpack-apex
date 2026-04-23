/**
 * @jest-environment jsdom
 *
 * /clients page — edit + delete flow. Mirrors the features page test
 * shape (expand card → inline edit/delete) so the pair stays in sync.
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const fetchMock = jest.fn();

jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...args: unknown[]) => fetchMock(...args),
  jsonHeaders: () => ({ "content-type": "application/json" }),
}));

const SEED_CLIENTS = [
  {
    id: "c-1",
    name: "Acme",
    industry: "tech",
    contact_email: "ops@acme.dev",
    contact_name: "Jane",
    notes: "VIP",
    docs: [],
    created_at: "2026-04-01T00:00:00Z",
  },
];

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => {
    if (typeof url === "string" && url === "/api/clients") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ clients: SEED_CLIENTS }),
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
  const mod = await import("@/app/(dashboard)/clients/page");
  const Page = mod.default;
  await act(async () => {
    render(<Page />);
  });
  await waitFor(() => {
    expect(screen.getByText(/^Acme$/)).toBeInTheDocument();
  });
  // Expand the card (click the card title) so edit/delete render.
  await act(async () => {
    fireEvent.click(screen.getByText(/^Acme$/));
  });
}

test("Edit button reveals form pre-filled with client values", async () => {
  await renderPage();

  await act(async () => {
    fireEvent.click(await screen.findByTestId("client-edit-btn-c-1"));
  });

  const form = await screen.findByTestId("client-edit-form-c-1");
  expect(form).toBeInTheDocument();
  const name = screen.getByLabelText(/edit name/i) as HTMLInputElement;
  expect(name.value).toBe("Acme");
});

test("Save sends PUT to /api/clients/[id] with updated fields (200)", async () => {
  await renderPage();

  await act(async () => {
    fireEvent.click(await screen.findByTestId("client-edit-btn-c-1"));
  });

  const name = await screen.findByLabelText(/edit name/i);
  await act(async () => {
    fireEvent.change(name, { target: { value: "Acme Corp" } });
  });

  fetchMock.mockImplementationOnce((url: string, init?: RequestInit) => {
    expect(url).toBe("/api/clients/c-1");
    expect(init?.method).toBe("PUT");
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ ok: true, client: { ...SEED_CLIENTS[0], name: "Acme Corp" } }),
    } as Response);
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
  });

  await waitFor(() => {
    const putCall = fetchMock.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0] === "/api/clients/c-1",
    );
    expect(putCall).toBeDefined();
    expect((putCall?.[1] as RequestInit).method).toBe("PUT");
  });
});

test("Delete confirm-cancel does NOT fire DELETE", async () => {
  await renderPage();

  const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(false);
  try {
    const callsBefore = fetchMock.mock.calls.length;
    await act(async () => {
      fireEvent.click(await screen.findByTestId("client-delete-btn-c-1"));
    });
    expect(confirmSpy).toHaveBeenCalled();
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    expect(screen.getByText(/^Acme$/)).toBeInTheDocument();
  } finally {
    confirmSpy.mockRestore();
  }
});

test("Delete confirm-accept sends DELETE and removes row optimistically", async () => {
  await renderPage();

  const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
  try {
    fetchMock.mockImplementationOnce((url: string, init?: RequestInit) => {
      expect(url).toBe("/api/clients/c-1");
      expect(init?.method).toBe("DELETE");
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, id: "c-1" }),
      } as Response);
    });

    await act(async () => {
      fireEvent.click(await screen.findByTestId("client-delete-btn-c-1"));
    });

    await waitFor(() => {
      expect(screen.queryByText(/^Acme$/)).not.toBeInTheDocument();
    });
  } finally {
    confirmSpy.mockRestore();
  }
});
