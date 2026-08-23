/**
 * @jest-environment jsdom
 *
 * /hr page: the roster list's edit + delete flow, through the real page.
 *
 * Covers:
 *   - Edit button reveals an inline form pre-filled with the row's values
 *   - Save calls PUT /api/people/employees/[id] via fetchWithRefresh
 *   - Delete confirm-cancel skips the network call
 *   - Delete confirm-accept calls DELETE /api/people/employees/[id]
 *   - Deleting the HR record of somebody who still has access does NOT remove
 *     them from the list, because they can still sign in
 *
 * The list is served by /api/people/roster now. It used to be
 * /api/people/employees, which showed only the records somebody typed in by
 * hand, so a teammate who accepted an invite had access and appeared nowhere.
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Stub all heavy tab children so only the roster code path is exercised.
jest.mock("@/components/people/OverviewTab", () => ({
  OverviewTab: () => <div data-testid="overview-tab-stub" />,
}));
jest.mock("@/components/people/OnboardingTab", () => ({
  OnboardingTab: () => <div data-testid="onboarding-tab-stub" />,
}));
jest.mock("@/components/people/BenefitsTab", () => ({
  BenefitsTab: () => <div data-testid="benefits-tab-stub" />,
}));
jest.mock("@/components/people/DocumentsTab", () => ({
  DocumentsTab: () => <div data-testid="documents-tab-stub" />,
}));
jest.mock("@/components/people/InsightsTab", () => ({
  InsightsTab: () => <div data-testid="insights-tab-stub" />,
}));
jest.mock("@/components/people/EmployeesTab", () => ({
  EmployeesTab: () => <div data-testid="employees-tab-stub" />,
}));

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...args: unknown[]) => mockFetchWithRefresh(...args),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
  authHeaders: () => ({}),
  /* The roster reads the signed-in person to decide whether to offer the
     role control. A CTO here, so these tests exercise the fuller page. */
  getInstinctUser: () => ({ id: "viewer-1", role: "cto" }),
}));

interface Row {
  key: string;
  name: string;
  email: string | null;
  role_title: string | null;
  department: string | null;
  employee_id: string | null;
  employee_status: string | null;
  member_id: string | null;
  account_role: string | null;
  invite_id: string | null;
  access: string;
  last_login: string | null;
  m365_connected: boolean;
}

const row = (o: Partial<Row> & { key: string; name: string }): Row => ({
  email: null,
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

/** Alice has an employee record only; Bob is there so deletions are visible. */
const SEED: Row[] = [
  row({
    key: "alice@example.com",
    name: "Alice",
    email: "alice@example.com",
    role_title: "Eng",
    department: "Platform",
    employee_id: "emp-1",
    employee_status: "active",
  }),
  row({
    key: "bob@example.com",
    name: "Bob",
    email: "bob@example.com",
    role_title: "PM",
    department: "Product",
    employee_id: "emp-2",
    employee_status: "active",
  }),
];

/** The roster the server would return, mutated by DELETE so refetch is honest. */
let roster: Row[] = [];

beforeAll(() => {
  Object.defineProperty(window, "localStorage", {
    value: {
      getItem() {
        return "employees";
      },
      setItem() {},
      removeItem() {},
    },
    writable: true,
  });
});

beforeEach(() => {
  roster = SEED.map((r) => ({ ...r }));
  mockFetchWithRefresh.mockReset();
  mockFetchWithRefresh.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === "/api/people/roster") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ roster, can_manage_access: true }),
      } as unknown as Response);
    }
    /* Model what the server actually does on DELETE, so the refetch after it
       reflects reality rather than replaying the original list. */
    if (init?.method === "DELETE") {
      const id = url.split("/").pop();
      roster = roster
        .map((r) =>
          r.employee_id === id
            ? { ...r, employee_id: null, employee_status: null, role_title: null, department: null }
            : r,
        )
        .filter((r) => r.employee_id !== null || r.member_id !== null);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true }),
    } as unknown as Response);
  });
});

async function renderPage() {
  const mod = await import("@/app/(dashboard)/hr/page");
  const Page = mod.default;
  await act(async () => {
    render(<Page />);
  });
  await waitFor(() => {
    expect(screen.getByText(/Alice/)).toBeInTheDocument();
  });
}

test("the list comes from the roster endpoint, so account-only people appear", async () => {
  roster = [row({ key: "m@example.com", name: "Invited Only", email: "m@example.com", member_id: "m1", access: "active" })];
  const mod = await import("@/app/(dashboard)/hr/page");
  const Page = mod.default;
  await act(async () => {
    render(<Page />);
  });
  expect(await screen.findByText("Invited Only")).toBeInTheDocument();
  expect(mockFetchWithRefresh).toHaveBeenCalledWith("/api/people/roster");
});

test("Edit button reveals inline form pre-filled with employee values", async () => {
  await renderPage();

  await act(async () => {
    fireEvent.click(screen.getByTestId("employee-edit-btn-emp-1"));
  });

  const form = await screen.findByTestId("employee-edit-form-emp-1");
  expect(form).toBeInTheDocument();
  const name = screen.getByLabelText(/edit full name/i) as HTMLInputElement;
  const email = screen.getByLabelText(/edit email/i) as HTMLInputElement;
  expect(name.value).toBe("Alice");
  expect(email.value).toBe("alice@example.com");
});

test("Save calls PUT /api/people/employees/[id]", async () => {
  await renderPage();

  await act(async () => {
    fireEvent.click(screen.getByTestId("employee-edit-btn-emp-1"));
  });

  const name = await screen.findByLabelText(/edit full name/i);
  await act(async () => {
    fireEvent.change(name, { target: { value: "Alice 2" } });
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
  });

  await waitFor(() => {
    const putCall = mockFetchWithRefresh.mock.calls.find(
      (c) => c[1]?.method === "PUT" && c[0] === "/api/people/employees/emp-1",
    );
    expect(putCall).toBeDefined();
    const body = JSON.parse(putCall![1].body as string);
    expect(body.full_name).toBe("Alice 2");
  });
});

test("Delete confirm-cancel does NOT call the network", async () => {
  await renderPage();
  const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(false);
  try {
    await act(async () => {
      fireEvent.click(screen.getByTestId("employee-delete-btn-emp-1"));
    });
    expect(confirmSpy).toHaveBeenCalled();
    await Promise.resolve();
    const deleteCall = mockFetchWithRefresh.mock.calls.find((c) => c[1]?.method === "DELETE");
    expect(deleteCall).toBeUndefined();
  } finally {
    confirmSpy.mockRestore();
  }
});

test("Delete confirm-accept calls DELETE + drops the row", async () => {
  await renderPage();
  const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
  try {
    await act(async () => {
      fireEvent.click(screen.getByTestId("employee-delete-btn-emp-1"));
    });
    await waitFor(() => {
      const deleteCall = mockFetchWithRefresh.mock.calls.find(
        (c) => c[1]?.method === "DELETE" && c[0] === "/api/people/employees/emp-1",
      );
      expect(deleteCall).toBeDefined();
    });
    await waitFor(() => {
      expect(screen.queryByTestId("roster-row-alice@example.com")).not.toBeInTheDocument();
    });
    // Bob still there
    expect(screen.getByTestId("roster-row-bob@example.com")).toBeInTheDocument();
  } finally {
    confirmSpy.mockRestore();
  }
});

test("deleting the HR record of somebody with access keeps them listed", async () => {
  /* They can still sign in. Dropping them from the list is how a leaver becomes
     invisible while their credentials keep working, which is the failure this
     whole page was rebuilt to prevent. */
  roster = [
    row({
      key: "carol@example.com",
      name: "Carol",
      email: "carol@example.com",
      employee_id: "emp-9",
      employee_status: "active",
      member_id: "m9",
      account_role: "ops",
      access: "active",
    }),
  ];
  const mod = await import("@/app/(dashboard)/hr/page");
  const Page = mod.default;
  await act(async () => {
    render(<Page />);
  });
  await screen.findByText("Carol");

  const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
  try {
    await act(async () => {
      fireEvent.click(screen.getByTestId("employee-delete-btn-emp-9"));
    });
    await waitFor(() => {
      expect(
        mockFetchWithRefresh.mock.calls.some((c) => c[1]?.method === "DELETE"),
      ).toBe(true);
    });
    // Still on the roster, still shown as having access.
    expect(await screen.findByText("Carol")).toBeInTheDocument();
    expect(screen.getByTestId("roster-access-carol@example.com")).toHaveTextContent("Has access");
  } finally {
    confirmSpy.mockRestore();
  }
});
