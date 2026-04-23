/**
 * @jest-environment jsdom
 *
 * /discussions page — thread + reply edit/delete flow.
 *
 * Covers rendering the detail view and asserting that the new
 * Edit/Delete buttons route through fetchWithRefresh to the correct
 * PUT / DELETE endpoints.
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...args: unknown[]) => mockFetchWithRefresh(...args),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
  authHeaders: () => ({}),
}));

jest.mock("@/lib/discussions-offline", () => ({
  sendDiscussionThreadOffline: jest.fn(),
  sendDiscussionReplyOffline: jest.fn(),
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
  ],
};

beforeAll(() => {
  Object.defineProperty(window, "localStorage", {
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    writable: true,
  });
});

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockFetchWithRefresh.mockImplementation((url: string, init?: RequestInit) => {
    if (typeof url === "string" && url === "/api/discussions") {
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
    // PUT / DELETE / analytics → benign 200
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true }),
    } as unknown as Response);
  });
});

async function renderPageAndOpenThread() {
  const mod = await import("@/app/(dashboard)/discussions/page");
  const Page = mod.default;
  await act(async () => {
    render(<Page />);
  });
  await waitFor(() => {
    expect(screen.getByText(/Kickoff/)).toBeInTheDocument();
  });
  await act(async () => {
    fireEvent.click(screen.getByText(/Kickoff/));
  });
  await waitFor(() => {
    expect(screen.getByTestId("thread-edit-btn")).toBeInTheDocument();
  });
}

test("Thread detail shows Edit / Delete buttons", async () => {
  await renderPageAndOpenThread();
  expect(screen.getByTestId("thread-edit-btn")).toBeInTheDocument();
  expect(screen.getByTestId("thread-delete-btn")).toBeInTheDocument();
});

test("Clicking thread Edit reveals an edit form pre-filled with values", async () => {
  await renderPageAndOpenThread();
  await act(async () => {
    fireEvent.click(screen.getByTestId("thread-edit-btn"));
  });
  const form = await screen.findByTestId("thread-edit-form");
  expect(form).toBeInTheDocument();
  const title = screen.getByLabelText(/edit thread title/i) as HTMLInputElement;
  expect(title.value).toBe("Kickoff");
});

test("Thread delete confirm-accept calls DELETE /api/discussions/[id]", async () => {
  await renderPageAndOpenThread();
  await act(async () => {
    fireEvent.click(screen.getByTestId("thread-delete-btn"));
  });
  // Custom ConfirmDialog replaces window.confirm — click the primary button.
  await waitFor(() => {
    expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
  });
  await waitFor(() => {
    const call = mockFetchWithRefresh.mock.calls.find(
      (c) => c[1]?.method === "DELETE" && c[0] === "/api/discussions/d-1",
    );
    expect(call).toBeDefined();
  });
});

test("Reply edit button reveals a form; save fires PUT to comments/[commentId]", async () => {
  await renderPageAndOpenThread();
  await act(async () => {
    fireEvent.click(screen.getByTestId("reply-edit-btn-r-1"));
  });
  const form = await screen.findByTestId("reply-edit-form-r-1");
  expect(form).toBeInTheDocument();
  const textarea = screen.getByLabelText(/edit comment content/i) as HTMLTextAreaElement;
  await act(async () => {
    fireEvent.change(textarea, { target: { value: "Edited body" } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
  });
  await waitFor(() => {
    const call = mockFetchWithRefresh.mock.calls.find(
      (c) =>
        c[1]?.method === "PUT" &&
        c[0] === "/api/discussions/d-1/comments/r-1",
    );
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.content).toBe("Edited body");
  });
});

test("Reply delete confirm-accept fires DELETE to comments/[commentId]", async () => {
  await renderPageAndOpenThread();
  await act(async () => {
    fireEvent.click(screen.getByTestId("reply-delete-btn-r-1"));
  });
  await waitFor(() => {
    expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
  });
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
