/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import WatchedReposPanel from "@/components/ai-code/WatchedReposPanel";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "content-type": "application/json" }),
}));

const listResponse = (repos: unknown[]) => ({ ok: true, json: async () => ({ repos }) });

beforeEach(() => jest.clearAllMocks());

it("shows the empty state when nothing is enrolled", async () => {
  mockFetch.mockResolvedValue(listResponse([]));
  render(<WatchedReposPanel />);
  await waitFor(() => expect(screen.getByText(/No repositories enrolled yet/i)).toBeInTheDocument());
});

it("lists enrolled repos with their status", async () => {
  mockFetch.mockResolvedValue(listResponse([{ repo: "o/r", enabled: true, createdAt: "2026-09-30T00:00:00Z" }]));
  render(<WatchedReposPanel />);
  await waitFor(() => expect(screen.getByText("o/r")).toBeInTheDocument());
  expect(screen.getByText("Watching")).toBeInTheDocument();
});

it("rejects a malformed repo client-side without calling the API", async () => {
  mockFetch.mockResolvedValue(listResponse([]));
  render(<WatchedReposPanel />);
  await waitFor(() => expect(screen.getByText(/No repositories enrolled yet/i)).toBeInTheDocument());
  mockFetch.mockClear();
  fireEvent.change(screen.getByLabelText(/Repository/i), { target: { value: "not-a-repo" } });
  fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/owner\/name/i));
  expect(mockFetch).not.toHaveBeenCalled(); // no POST fired
});

it("enrolls a valid repo (POST) then reloads the list", async () => {
  mockFetch
    .mockResolvedValueOnce(listResponse([])) // initial load
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) }) // POST
    .mockResolvedValueOnce(listResponse([{ repo: "o/new", enabled: true, createdAt: "2026-09-30T00:00:00Z" }])); // reload
  render(<WatchedReposPanel />);
  await waitFor(() => expect(screen.getByText(/No repositories enrolled yet/i)).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText(/Repository/i), { target: { value: "o/new" } });
  fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
  await waitFor(() => expect(screen.getByText("o/new")).toBeInTheDocument());
  const call = mockFetch.mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === "POST");
  expect(call).toBeTruthy();
});
