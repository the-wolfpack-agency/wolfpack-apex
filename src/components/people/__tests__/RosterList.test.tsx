/**
 * @jest-environment jsdom
 *
 * /hr roster list.
 *
 * The reported bug, in the user's words: "this page only displays employees I
 * add. It does not display full active member list, this is wrong since I cant
 * see who has access, who doesnt, and I cant remove or re-add anyone."
 *
 * So the tests here are about exactly those three things: everyone appears,
 * their access state is legible, and it can be taken away and given back.
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RosterList } from "../RosterList";

const mockFetchWithRefresh = jest.fn();
const mockUser = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...args: unknown[]) => mockFetchWithRefresh(...args),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
  getInstinctUser: () => mockUser(),
}));

type Entry = Record<string, unknown>;

const entry = (o: Entry): Entry => ({
  key: "k",
  name: "Person",
  email: "p@wolfpack.test",
  role_title: null,
  department: null,
  employee_id: null,
  employee_status: null,
  member_id: null,
  account_role: null,
  invite_id: null,
  access: "none",
  last_login: null,
  m365_connected: false,
  ...o,
});

const ok = (body: unknown) => ({ ok: true, json: async () => body });
const fail = (status: number, body: unknown = {}) => ({ ok: false, status, json: async () => body });

/** Serve the roster GET; every other call resolves ok unless overridden. */
function serveRoster(roster: Entry[], canManage = true) {
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (url === "/api/people/roster") return Promise.resolve(ok({ roster, can_manage_access: canManage }));
    return Promise.resolve(ok({ ok: true }));
  });
}

beforeEach(() => {
  mockUser.mockReturnValue({ id: "viewer-1", role: "cto" });
  jest.clearAllMocks();
  jest.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => jest.restoreAllMocks());

describe("everyone appears, not only typed-in employees", () => {
  it("lists somebody who has an account and no employee record", async () => {
    // The exact regression: this person was invisible before.
    serveRoster([
      entry({ key: "new@wolfpack.test", name: "Newcomer", member_id: "m1", access: "active" }),
    ]);
    render(<RosterList />);
    expect(await screen.findByText("Newcomer")).toBeInTheDocument();
    expect(screen.getByTestId("roster-access-new@wolfpack.test")).toHaveTextContent("Has access");
  });

  it("reads the roster endpoint, not the employees-only one", async () => {
    serveRoster([]);
    render(<RosterList />);
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalledWith("/api/people/roster"));
  });
});

describe("who has access and who does not", () => {
  it.each([
    ["active", "Has access"],
    ["invited", "Invited"],
    ["revoked", "Access removed"],
    ["none", "No account"],
  ])("labels %s as %s", async (access, label) => {
    serveRoster([entry({ key: "x", name: "X", access })]);
    render(<RosterList />);
    expect(await screen.findByTestId("roster-access-x")).toHaveTextContent(label);
  });
});

describe("removing and restoring access", () => {
  it("posts active:false and refetches", async () => {
    serveRoster([entry({ key: "a", name: "Ann", member_id: "m1", access: "active" })]);
    render(<RosterList />);
    fireEvent.click(await screen.findByTestId("access-revoke-btn-m1"));
    await waitFor(() =>
      expect(mockFetchWithRefresh).toHaveBeenCalledWith(
        "/api/people/roster/m1/access",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ active: false }) }),
      ),
    );
    // Refetched, so the row reflects the new state rather than a guess.
    await waitFor(() =>
      expect(mockFetchWithRefresh.mock.calls.filter((c) => c[0] === "/api/people/roster")).toHaveLength(2),
    );
  });

  it("confirms first, and does nothing when the confirm is declined", async () => {
    (window.confirm as jest.Mock).mockReturnValue(false);
    serveRoster([entry({ key: "a", name: "Ann", member_id: "m1", access: "active" })]);
    render(<RosterList />);
    fireEvent.click(await screen.findByTestId("access-revoke-btn-m1"));
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(mockFetchWithRefresh).not.toHaveBeenCalledWith(
      "/api/people/roster/m1/access",
      expect.anything(),
    );
  });

  it("offers restore, not remove, for somebody already removed", async () => {
    serveRoster([entry({ key: "b", name: "Bob", member_id: "m2", access: "revoked" })]);
    render(<RosterList />);
    expect(await screen.findByTestId("access-restore-btn-m2")).toBeInTheDocument();
    expect(screen.queryByTestId("access-revoke-btn-m2")).not.toBeInTheDocument();
  });

  it("posts active:true without confirming, since restoring is not destructive", async () => {
    serveRoster([entry({ key: "b", name: "Bob", member_id: "m2", access: "revoked" })]);
    render(<RosterList />);
    fireEvent.click(await screen.findByTestId("access-restore-btn-m2"));
    await waitFor(() =>
      expect(mockFetchWithRefresh).toHaveBeenCalledWith(
        "/api/people/roster/m2/access",
        expect.objectContaining({ body: JSON.stringify({ active: true }) }),
      ),
    );
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("surfaces a refusal instead of silently doing nothing", async () => {
    mockFetchWithRefresh.mockImplementation((url: string) => {
      if (url === "/api/people/roster") {
        return Promise.resolve(
          ok({ roster: [entry({ key: "a", name: "Ann", member_id: "m1", access: "active" })], can_manage_access: true }),
        );
      }
      return Promise.resolve(fail(400, { error: "You cannot remove your own access." }));
    });
    render(<RosterList />);
    fireEvent.click(await screen.findByTestId("access-revoke-btn-m1"));
    expect(await screen.findByTestId("roster-access-error")).toHaveTextContent(
      "You cannot remove your own access.",
    );
  });
});

describe("who may change access", () => {
  it("hides the controls when the server says the viewer cannot manage access", async () => {
    // HR sees the roster but does not hold settings.manage_team. The endpoint
    // enforces that itself; this only avoids showing a button that would 403.
    serveRoster([entry({ key: "a", name: "Ann", member_id: "m1", access: "active" })], false);
    render(<RosterList />);
    expect(await screen.findByText("Ann")).toBeInTheDocument();
    expect(screen.queryByTestId("access-revoke-btn-m1")).not.toBeInTheDocument();
  });

  it("shows no access control for somebody who has no account to revoke", async () => {
    serveRoster([entry({ key: "e", name: "Ed", employee_id: "e1", access: "none" })]);
    render(<RosterList />);
    expect(await screen.findByText("Ed")).toBeInTheDocument();
    expect(screen.queryByText("Remove access")).not.toBeInTheDocument();
  });
});

describe("employee records", () => {
  it("offers edit and delete only where there is a record to edit", async () => {
    serveRoster([
      entry({ key: "e", name: "Ed", employee_id: "e1", access: "none" }),
      entry({ key: "m", name: "Mia", member_id: "m1", access: "active" }),
    ]);
    render(<RosterList />);
    expect(await screen.findByTestId("employee-edit-btn-e1")).toBeInTheDocument();
    expect(screen.queryByTestId("employee-edit-btn-m1")).not.toBeInTheDocument();
  });

  it("warns that deleting the HR record leaves access intact", async () => {
    // Conflating the two registers is how a leaver keeps working credentials.
    serveRoster([
      entry({ key: "a", name: "Ann", employee_id: "e1", member_id: "m1", access: "active" }),
    ]);
    render(<RosterList />);
    fireEvent.click(await screen.findByTestId("employee-delete-btn-e1"));
    await waitFor(() =>
      expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("keep their access")),
    );
  });
});

describe("refreshing after something changed elsewhere on the tab", () => {
  it("refetches when refreshToken changes", async () => {
    // Adding an employee or sending an invite both change the roster. Without
    // this the person you just added stays invisible until a reload, which is
    // the complaint itself.
    serveRoster([]);
    const { rerender } = render(<RosterList refreshToken={0} />);
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalledTimes(1));
    rerender(<RosterList refreshToken={1} />);
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalledTimes(2));
  });

  it("does not refetch on an unrelated re-render", async () => {
    serveRoster([]);
    const { rerender } = render(<RosterList refreshToken={3} />);
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalledTimes(1));
    rerender(<RosterList refreshToken={3} />);
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalledTimes(1));
  });
});

describe("when the roster cannot be loaded", () => {
  it("says so rather than rendering an empty team", async () => {
    // "Nobody has access" is a confident, wrong answer somebody would act on.
    mockFetchWithRefresh.mockResolvedValue(fail(503, { error: "Database temporarily unavailable." }));
    render(<RosterList />);
    expect(await screen.findByTestId("roster-load-error")).toHaveTextContent(
      "Database temporarily unavailable.",
    );
  });

  it("distinguishes a genuinely empty workspace from a failure", async () => {
    serveRoster([]);
    render(<RosterList />);
    expect(await screen.findByText(/Nobody yet/)).toBeInTheDocument();
    expect(screen.queryByTestId("roster-load-error")).not.toBeInTheDocument();
  });
});

describe("changing somebody's account role", () => {
  const roster = [
    { key: "k1", name: "Dana Ruiz", email: "d@x.test", role_title: null, department: null, employee_id: null, employee_status: null, member_id: "m-dana", account_role: "ops", invite_id: null, access: "active", last_login: null, m365_connected: false },
    { key: "k2", name: "You", email: "y@x.test", role_title: null, department: null, employee_id: null, employee_status: null, member_id: "viewer-1", account_role: "cto", invite_id: null, access: "active", last_login: null, m365_connected: false },
  ];

  function respondRoster() {
    mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({ roster }) });
  }

  it("offers the control to somebody who may assign roles", async () => {
    respondRoster();
    render(<RosterList />);
    expect(await screen.findByTestId("roster-role-k1")).toBeInTheDocument();
  });

  it("does NOT offer it to somebody who may not", async () => {
    /* Derived from the same capability map the server enforces, so the control
       and the endpoint cannot disagree about who may do this. */
    mockUser.mockReturnValue({ id: "viewer-1", role: "designer" });
    respondRoster();
    render(<RosterList />);
    await screen.findByTestId("roster-row-k1");
    expect(screen.queryByTestId("roster-role-k1")).not.toBeInTheDocument();
  });

  it("disables it on your own row rather than hiding it", async () => {
    /* Hiding reads as a missing feature and somebody goes looking for it. The
       reason is on the control itself. */
    respondRoster();
    render(<RosterList />);
    const own = await screen.findByTestId("roster-role-k2");
    expect(own).toBeDisabled();
    expect(own).toHaveAttribute("title", expect.stringMatching(/cannot change your own role/i));
  });

  it("lists every assignable role, read from the shared map", async () => {
    respondRoster();
    render(<RosterList />);
    const select = await screen.findByTestId("roster-role-k1");
    const values = Array.from(select.querySelectorAll("option")).map((o) => o.getAttribute("value"));
    /* Exactly the roles the database's own check constraint permits. */
    expect(values).toEqual(expect.arrayContaining(["cto", "ceo", "ops", "designer", "sales", "hr", "dev"]));
    expect(values).not.toContain("member");
  });

  it("posts the change to the endpoint that audits it", async () => {
    respondRoster();
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
    render(<RosterList />);
    const select = await screen.findByTestId("roster-role-k1");

    fireEvent.change(select, { target: { value: "dev" } });

    await waitFor(() =>
      expect(mockFetchWithRefresh).toHaveBeenCalledWith(
        "/api/admin/users/m-dana/role",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ role: "dev" }) }),
      ),
    );
    confirmSpy.mockRestore();
  });

  it("asks first, naming both ends of the change", async () => {
    /* This is the one control here that changes what another person is ALLOWED
       to do rather than what they can see. */
    respondRoster();
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(false);
    render(<RosterList />);
    fireEvent.change(await screen.findByTestId("roster-role-k1"), { target: { value: "dev" } });

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/from ops to dev/i));
    expect(mockFetchWithRefresh).not.toHaveBeenCalledWith(
      expect.stringContaining("/role"),
      expect.anything(),
    );
    confirmSpy.mockRestore();
  });

  it("shows the server's own reason when it refuses", async () => {
    respondRoster();
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
    render(<RosterList />);
    await screen.findByTestId("roster-role-k1");

    mockFetchWithRefresh.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "cannot_change_own_role", message: "You cannot change your own role. Ask another admin." }),
    });
    fireEvent.change(screen.getByTestId("roster-role-k1"), { target: { value: "dev" } });

    expect(await screen.findByText(/ask another admin/i)).toBeInTheDocument();
    confirmSpy.mockRestore();
  });
});
