/**
 * @jest-environment jsdom
 *
 * /discussions page — the three Apr 23 enhancements:
 *   1. "Notify all Wolfpack team members" checkbox on the Create form
 *      routes through fetchWithRefresh POST /api/discussions with
 *      notify_all:true and hits the server directly (not the offline helper).
 *   2. Delete uses ConfirmDialog, not window.confirm — cancel aborts,
 *      confirm fires DELETE.
 *   3. Thread + reply delete are optimiztic: the row disappears before
 *      the network call resolves, and a rollback+toast surfaces on error.
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...args: unknown[]) => mockFetchWithRefresh(...args),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
  authHeaders: () => ({}),
}));

const mockSendThreadOffline = jest.fn();
const mockSendReplyOffline = jest.fn();
jest.mock("@/lib/discussions-offline", () => ({
  sendDiscussionThreadOffline: (...args: unknown[]) =>
    mockSendThreadOffline(...args),
  sendDiscussionReplyOffline: (...args: unknown[]) =>
    mockSendReplyOffline(...args),
}));

const THREADS = [
  {
    id: "d-1",
    title: "Kickoff",
    category: "general",
    created_by: "u-owner",
    status: "open",
    pinned: false,
    tags: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    reply_count: 1,
  },
  {
    id: "d-2",
    title: "Retro",
    category: "process",
    created_by: "u-owner",
    status: "open",
    pinned: false,
    tags: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    reply_count: 0,
  },
];

const THREAD_DETAIL = {
  discussion: THREADS[0],
  replies: [
    {
      id: "r-1",
      discussion_id: "d-1",
      author_id: "u-owner",
      content: "Original body",
      created_at: new Date().toISOString(),
      author_name: "Owner",
      author_role: "dev",
    },
    {
      id: "r-2",
      discussion_id: "d-1",
      author_id: "u-other",
      content: "Another reply",
      created_at: new Date().toISOString(),
      author_name: "Other",
      author_role: "dev",
    },
  ],
};

beforeAll(() => {
  Object.defineProperty(window, "localStorage", {
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    writable: true,
  });
});

function defaultFetchImpl(url: string, init?: RequestInit) {
  if (typeof url === "string" && url === "/api/discussions" && (!init || !init.method || init.method === "GET")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ threads: THREADS }),
    } as unknown as Response);
  }
  if (typeof url === "string" && url === "/api/discussions/d-1" && (!init || !init.method || init.method === "GET")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(THREAD_DETAIL),
    } as unknown as Response);
  }
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ ok: true }),
  } as unknown as Response);
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockSendThreadOffline.mockReset();
  mockSendReplyOffline.mockReset();
  mockFetchWithRefresh.mockImplementation(defaultFetchImpl);
  mockSendThreadOffline.mockResolvedValue({ status: "sent", id: "d-new" });
});

async function renderPage() {
  const mod = await import("@/app/(dashboard)/discussions/page");
  const Page = mod.default;
  await act(async () => {
    render(<Page />);
  });
  await waitFor(() => {
    expect(screen.getByText(/Kickoff/)).toBeInTheDocument();
  });
}

async function openKickoff() {
  await act(async () => {
    fireEvent.click(screen.getByText(/Kickoff/));
  });
  await waitFor(() => {
    expect(screen.getByTestId("thread-edit-btn")).toBeInTheDocument();
  });
}

// ---------------------------------------------------------------------------
// Task 1 — notify-all checkbox routes through fetchWithRefresh with the flag.
// ---------------------------------------------------------------------------

test("notify-all checkbox → POST /api/discussions with notify_all:true (not offline helper)", async () => {
  await renderPage();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /new discussion/i }));
  });
  await act(async () => {
    fireEvent.change(screen.getByPlaceholderText(/discussion title/i), {
      target: { value: "All-hands topic" },
    });
    fireEvent.change(screen.getByPlaceholderText(/start the discussion/i), {
      target: { value: "Anyone around?" },
    });
    fireEvent.click(screen.getByTestId("notify-all-checkbox"));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /create discussion/i }));
  });

  await waitFor(() => {
    const call = mockFetchWithRefresh.mock.calls.find(
      (c) => c[0] === "/api/discussions" && c[1]?.method === "POST",
    );
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.notify_all).toBe(true);
    expect(body.title).toBe("All-hands topic");
  });
  // Offline helper must NOT be used on the notify-all path.
  expect(mockSendThreadOffline).not.toHaveBeenCalled();
});

test("unchecked notify-all still routes through offline-aware helper", async () => {
  await renderPage();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /new discussion/i }));
  });
  await act(async () => {
    fireEvent.change(screen.getByPlaceholderText(/discussion title/i), {
      target: { value: "Quiet topic" },
    });
    fireEvent.change(screen.getByPlaceholderText(/start the discussion/i), {
      target: { value: "No fanout please" },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /create discussion/i }));
  });
  await waitFor(() => {
    expect(mockSendThreadOffline).toHaveBeenCalledTimes(1);
  });
  const call = mockFetchWithRefresh.mock.calls.find(
    (c) => c[0] === "/api/discussions" && c[1]?.method === "POST",
  );
  expect(call).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Task 2 — custom ConfirmDialog replaces window.confirm.
// ---------------------------------------------------------------------------

test("thread delete opens ConfirmDialog (not window.confirm)", async () => {
  const confirmSpy = jest.spyOn(window, "confirm");
  await renderPage();
  await openKickoff();
  await act(async () => {
    fireEvent.click(screen.getByTestId("thread-delete-btn"));
  });
  expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
  expect(confirmSpy).not.toHaveBeenCalled();
  confirmSpy.mockRestore();
});

test("ConfirmDialog Cancel aborts the delete", async () => {
  await renderPage();
  await openKickoff();
  await act(async () => {
    fireEvent.click(screen.getByTestId("thread-delete-btn"));
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
  });
  // Dialog gone, and no DELETE fired.
  expect(screen.queryByTestId("confirm-dialog")).toBeNull();
  const deleteCall = mockFetchWithRefresh.mock.calls.find(
    (c) => c[1]?.method === "DELETE",
  );
  expect(deleteCall).toBeUndefined();
});

test("reply delete opens ConfirmDialog and Confirm issues DELETE", async () => {
  await renderPage();
  await openKickoff();
  await act(async () => {
    fireEvent.click(screen.getByTestId("reply-delete-btn-r-1"));
  });
  expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
  await act(async () => {
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
  });
  await waitFor(() => {
    const call = mockFetchWithRefresh.mock.calls.find(
      (c) =>
        c[1]?.method === "DELETE" &&
        c[0] === "/api/discussions/d-1/comments/r-1",
    );
    expect(call).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Task 3 — optimiztic delete for threads + replies, with rollback on error.
// ---------------------------------------------------------------------------

test("thread delete is optimiztic: row disappears before server resolves", async () => {
  let resolveDelete: ((res: Response) => void) | undefined;
  mockFetchWithRefresh.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === "DELETE" && url === "/api/discussions/d-1") {
      return new Promise<Response>((resolve) => {
        resolveDelete = resolve;
      });
    }
    return defaultFetchImpl(url, init);
  });

  await renderPage();
  await openKickoff();
  await act(async () => {
    fireEvent.click(screen.getByTestId("thread-delete-btn"));
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
  });

  // Before the DELETE resolves, the optimiztic update has already closed
  // the detail view and dropped the row from the list.
  await waitFor(() => {
    expect(screen.queryByTestId("thread-edit-btn")).toBeNull();
    expect(screen.queryByText("Kickoff")).toBeNull();
  });

  await act(async () => {
    resolveDelete!({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, id: "d-1" }),
    } as unknown as Response);
  });
});

test("thread delete rolls back + toasts when server returns 500", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === "DELETE" && url === "/api/discussions/d-1") {
      return Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "boom" }),
      } as unknown as Response);
    }
    return defaultFetchImpl(url, init);
  });

  await renderPage();
  await openKickoff();
  await act(async () => {
    fireEvent.click(screen.getByTestId("thread-delete-btn"));
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
  });

  // Row is restored, toast is shown.
  await waitFor(() => {
    expect(screen.getByTestId("discussions-toast")).toBeInTheDocument();
  });
  // Back on the thread detail (restored selectedThread).
  expect(screen.getByTestId("thread-edit-btn")).toBeInTheDocument();
});

test("reply delete is optimiztic and rolls back on error", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, init?: RequestInit) => {
    if (
      init?.method === "DELETE" &&
      url === "/api/discussions/d-1/comments/r-1"
    ) {
      return Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "boom" }),
      } as unknown as Response);
    }
    return defaultFetchImpl(url, init);
  });

  await renderPage();
  await openKickoff();

  // Sanity: both replies visible before delete.
  expect(screen.getAllByTestId("reply-r-1").length).toBeGreaterThan(0);
  expect(screen.getAllByTestId("reply-r-2").length).toBeGreaterThan(0);

  await act(async () => {
    fireEvent.click(screen.getByTestId("reply-delete-btn-r-1"));
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
  });

  await waitFor(() => {
    expect(screen.getByTestId("discussions-toast")).toBeInTheDocument();
  });
  // r-1 is restored (rollback) and r-2 is still there.
  expect(screen.getAllByTestId("reply-r-1").length).toBeGreaterThan(0);
  expect(screen.getAllByTestId("reply-r-2").length).toBeGreaterThan(0);
});
