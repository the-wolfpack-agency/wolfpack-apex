/**
 * @jest-environment jsdom
 *
 * /hr page — EmployeeEditor edit + delete flow.
 *
 * Covers:
 *   - Edit button reveals inline form pre-filled with the row's values
 *   - Save calls PUT /api/people/employees/[id] via fetchWithRefresh + refetches
 *   - Delete confirm-cancel skips the network call
 *   - Delete confirm-accept calls DELETE /api/people/employees/[id]
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Stub all heavy tab children so only the EmployeesTab + EmployeeEditor
// code path is exercised.
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
}));

const SEED = [
  {
    id: "emp-1",
    full_name: "Alice",
    email: "alice@example.com",
    role_title: "Eng",
    department: "Platform",
    status: "active",
  },
  {
    id: "emp-2",
    full_name: "Bob",
    email: "bob@example.com",
    role_title: "PM",
    department: "Product",
    status: "active",
  },
];

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
  mockFetchWithRefresh.mockReset();
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (typeof url === "string" && url === "/api/people/employees") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ employees: SEED }),
      } as unknown as Response);
    }
    // PUT / DELETE / anything else → benign 200
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
    const deleteCall = mockFetchWithRefresh.mock.calls.find(
      (c) => c[1]?.method === "DELETE",
    );
    expect(deleteCall).toBeUndefined();
  } finally {
    confirmSpy.mockRestore();
  }
});

test("Delete confirm-accept calls DELETE + removes row optimistically", async () => {
  await renderPage();
  const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
  try {
    await act(async () => {
      fireEvent.click(screen.getByTestId("employee-delete-btn-emp-1"));
    });
    await waitFor(() => {
      const deleteCall = mockFetchWithRefresh.mock.calls.find(
        (c) =>
          c[1]?.method === "DELETE" &&
          c[0] === "/api/people/employees/emp-1",
      );
      expect(deleteCall).toBeDefined();
    });
    await waitFor(() => {
      expect(screen.queryByTestId("employee-editor-row-emp-1")).not.toBeInTheDocument();
    });
    // Bob still there
    expect(screen.getByTestId("employee-editor-row-emp-2")).toBeInTheDocument();
  } finally {
    confirmSpy.mockRestore();
  }
});
