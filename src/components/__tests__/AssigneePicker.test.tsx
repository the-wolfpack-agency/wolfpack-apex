/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * AssigneePicker — directory-backed multi-select used to assign a task to an
 * individual. Covers: empty state after a search returns no one, rendering
 * directory results, selecting an option (fires onChange with the Graph user
 * id + fires the tasks.assignee_searched analytics beacon), and rendering
 * already-selected chips from knownById.
 */

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...args: any[]) => mockFetch(...args),
  authHeaders: () => ({ authorization: "Bearer test" }),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AssigneePicker, { type AssigneeOption } from "@/components/AssigneePicker";

function usersResponse(users: unknown[], ok = true, status = 200) {
  return { ok, status, json: async () => ({ users }) } as unknown as Response;
}
function analyticsResponse() {
  return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
}

const ALICE = {
  msUserId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  displayName: "Alice Ops",
  userPrincipalName: "alice@wpa.test",
  mail: "alice@wpa.test",
  jobTitle: "Coordinator",
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe("AssigneePicker", () => {
  it("renders an empty state when the directory search returns no one", async () => {
    // First call = /api/directory/users (empty), any others = analytics beacon.
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(url.startsWith("/api/directory/users") ? usersResponse([]) : analyticsResponse()),
    );
    render(<AssigneePicker context="tasks" value={[]} onChange={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("assignee-empty")).toBeInTheDocument());
    expect(screen.getByTestId("assignee-empty").textContent).toMatch(/Sync your directory/i);
  });

  it("renders directory results and selecting one fires onChange + analytics", async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(url.startsWith("/api/directory/users") ? usersResponse([ALICE]) : analyticsResponse()),
    );
    const onChange = jest.fn();
    render(<AssigneePicker context="tasks" value={[]} onChange={onChange} />);

    const option = await screen.findByTestId("assignee-option");
    expect(option).toHaveTextContent("Alice Ops");

    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith(
      [ALICE.msUserId],
      expect.arrayContaining([expect.objectContaining({ id: ALICE.msUserId, name: "Alice Ops" })]),
    );

    // The analytics beacon fired for the search (context carried through).
    await waitFor(() => {
      const beacon = mockFetch.mock.calls.find((c) => c[0] === "/api/analytics");
      expect(beacon).toBeTruthy();
      expect(JSON.parse(beacon![1].body).event).toBe("tasks.assignee_searched");
      expect(JSON.parse(beacon![1].body).metadata.context).toBe("tasks");
    });
  });

  it("renders already-selected assignees as chips from knownById", async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(url.startsWith("/api/directory/users") ? usersResponse([]) : analyticsResponse()),
    );
    const known: Record<string, AssigneeOption> = {
      [ALICE.msUserId]: { id: ALICE.msUserId, name: "Alice Ops" },
    };
    render(
      <AssigneePicker context="planner" value={[ALICE.msUserId]} onChange={() => {}} knownById={known} />,
    );
    const chip = await screen.findByTestId("assignee-chip");
    expect(chip).toHaveTextContent("Alice Ops");
  });
});
