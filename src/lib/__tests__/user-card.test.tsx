/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";

const fetchMockUC = jest.fn();

beforeAll(() => {
  global.fetch = fetchMockUC as unknown as typeof fetch;
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

beforeEach(() => fetchMockUC.mockReset());

const baseUser = {
  id: "uuid-1",
  msUserId: "ms-1",
  userPrincipalName: "alice@x.com",
  displayName: "Alice Park",
  givenName: "Alice",
  surname: "Park",
  mail: "alice@x.com",
  jobTitle: "Staff Engineer",
  department: "Platform",
  officeLocation: "HQ",
  businessPhones: ["555-1212"],
  mobilePhone: null,
  managerMsId: "ms-boss",
};

describe("<UserCard />", () => {
  test("renders immediately when user prop provided (cache hit)", async () => {
    const UserCard = (await import("@/components/directory/UserCard")).default;
    render(<UserCard user={baseUser} />);
    expect(screen.getByText("Alice Park")).toBeInTheDocument();
    expect(screen.getByText(/Staff Engineer/)).toBeInTheDocument();
    // No fetch — user was provided.
    expect(fetchMockUC).not.toHaveBeenCalled();
  });

  test("cache-miss: shows skeleton then fetches", async () => {
    fetchMockUC.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ user: baseUser }),
    });
    const UserCard = (await import("@/components/directory/UserCard")).default;
    render(<UserCard idOrUpn="ms-1" />);
    expect(screen.getByTestId("user-card-skeleton")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("Alice Park")).toBeInTheDocument();
    });
    expect(fetchMockUC).toHaveBeenCalledTimes(1);
  });

  test("renders 'User not found' when API returns 404", async () => {
    fetchMockUC.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    const UserCard = (await import("@/components/directory/UserCard")).default;
    render(<UserCard idOrUpn="missing" />);
    await waitFor(() => {
      expect(screen.getByText(/User not found/)).toBeInTheDocument();
    });
  });

  test("showDirectReports fetches + renders count", async () => {
    fetchMockUC.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ reports: [{ msUserId: "r1" }, { msUserId: "r2" }] }),
    });
    const UserCard = (await import("@/components/directory/UserCard")).default;
    render(<UserCard user={baseUser} showDirectReports />);
    await waitFor(() => {
      expect(screen.getByTestId("user-card-reports-count")).toHaveTextContent("2 reports");
    });
  });
});
