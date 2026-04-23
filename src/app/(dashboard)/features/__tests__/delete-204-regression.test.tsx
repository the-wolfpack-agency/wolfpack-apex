/**
 * @jest-environment jsdom
 *
 * Features delete — 204 No Content regression.
 *
 * Bug (reported 2026-04-23): "Failed to delete" appeared in the banner
 * after a deletion that actually succeeded. Root cause: handleDelete
 * gated on `res.status === 200`, but the DELETE response is 204 under
 * some proxy/middleware configurations. The client treated every
 * non-200 2xx as failure, fired `fetchFeatures()` again, and surfaced
 * the false-negative banner.
 *
 * Fix: gate on `res.ok` (2xx uniformly). This test pins the contract:
 * status=204 + ok=true must NOT render "Failed to delete" and must
 * leave the row removed from the list.
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
    id: "f-del-204",
    title: "Delete-me widget",
    description: "Row we want to remove",
    submitted_by: "u-owner",
    status: "submitted",
    priority: "medium",
    target_product: null,
    analysis: {},
    votes: 0,
    estimated_hours: null,
    estimated_cost: null,
    created_at: "2026-04-23T00:00:00Z",
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
    expect(screen.getByText(/Delete-me widget/)).toBeInTheDocument();
  });
  await act(async () => {
    fireEvent.click(screen.getByText(/Delete-me widget/));
  });
}

test("204 No Content on DELETE does NOT trigger the Failed-to-delete banner", async () => {
  await renderPage();

  const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
  try {
    // Simulate a 204 No Content response (body-less). The previous
    // implementation treated this as failure because it checked
    // res.status === 200; the fixed implementation checks res.ok.
    fetchMock.mockImplementationOnce((url: string, init?: RequestInit) => {
      expect(url).toBe("/api/features/f-del-204");
      expect(init?.method).toBe("DELETE");
      return Promise.resolve({
        ok: true,
        status: 204,
        // No json body — most middlewares omit it on 204. Calling
        // res.json() on a real 204 response throws "Unexpected end of
        // JSON input"; we stub it as a rejecting promise to mirror
        // that behavior.
        json: () => Promise.reject(new Error("Unexpected end of JSON input")),
      } as Response);
    });

    await act(async () => {
      fireEvent.click(await screen.findByTestId("feature-delete-btn-f-del-204"));
    });

    // Row was optimistically removed and must STAY removed.
    await waitFor(() => {
      expect(screen.queryByText(/Delete-me widget/)).not.toBeInTheDocument();
    });

    // Critical regression assertion: NO "Failed to delete" banner.
    expect(screen.queryByText(/Failed to delete/i)).not.toBeInTheDocument();
  } finally {
    confirmSpy.mockRestore();
  }
});

test("200 OK on DELETE still succeeds (back-compat with current API)", async () => {
  await renderPage();

  const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
  try {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, id: "f-del-204" }),
      } as Response),
    );

    await act(async () => {
      fireEvent.click(await screen.findByTestId("feature-delete-btn-f-del-204"));
    });

    await waitFor(() => {
      expect(screen.queryByText(/Delete-me widget/)).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/Failed to delete/i)).not.toBeInTheDocument();
  } finally {
    confirmSpy.mockRestore();
  }
});

test("500 on DELETE DOES surface Failed to delete", async () => {
  await renderPage();

  const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
  try {
    // Primary DELETE call returns 500; subsequent auto-refetch returns
    // the row back so the banner + restored list are both correct.
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "server" }),
      } as Response),
    );

    await act(async () => {
      fireEvent.click(await screen.findByTestId("feature-delete-btn-f-del-204"));
    });

    await waitFor(() => {
      expect(screen.getByText(/Failed to delete/i)).toBeInTheDocument();
    });
  } finally {
    confirmSpy.mockRestore();
  }
});
