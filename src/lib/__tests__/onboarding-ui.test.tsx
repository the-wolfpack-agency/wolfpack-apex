/**
 * @jest-environment jsdom
 */

/**
 * OnboardingTab UI tests.
 *
 * Locks the rendering and interaction behavior of the Onboarding sub-tab:
 *   1. Active onboarding cards render with progress bars
 *   2. Clicking a step checkbox triggers a PATCH
 *   3. "Start New Onboarding" form shows employee + template dropdowns
 *   4. Completed section renders past onboardings
 */

import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("next/link", () => {
  const Link = ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>;
  Link.displayName = "Link";
  return { __esModule: true, default: Link };
});

import { OnboardingTab } from "@/components/people/OnboardingTab";

const fetchMock = jest.fn();
beforeAll(() => {
  global.fetch = fetchMock;
  Object.defineProperty(window, "localStorage", {
    value: {
      _store: { instinct_token: "tok" } as Record<string, string>,
      getItem(this: { _store: Record<string, string> }, k: string) { return this._store[k] ?? null; },
      setItem(this: { _store: Record<string, string> }, k: string, v: string) { this._store[k] = v; },
      removeItem(this: { _store: Record<string, string> }, k: string) { delete this._store[k]; },
    },
    writable: true,
  });
});

beforeEach(() => {
  fetchMock.mockReset();
});

const ACTIVE_INSTANCE = {
  id: "ob_1",
  employee_id: "emp_1",
  template_name: "Engineering Hire",
  status: "in_progress",
  employee_name: "Jane Doe",
  started_at: "2026-04-01T00:00:00Z",
  completed_at: null,
  steps: [
    { step_id: "s1", title: "Sign offer letter", description: "Sign it", required: true, category: "paperwork", completed: true, completed_by: "u1", completed_at: "2026-04-02T00:00:00Z" },
    { step_id: "s2", title: "Set up GitHub", description: "Add to org", required: true, category: "access", completed: false, completed_by: null, completed_at: null },
    { step_id: "s3", title: "Meet the team", description: "Intro calls", required: false, category: "introductions", completed: false, completed_by: null, completed_at: null },
  ],
};

const COMPLETED_INSTANCE = {
  id: "ob_2",
  employee_id: "emp_2",
  template_name: "Sales Hire",
  status: "completed",
  employee_name: "John Smith",
  started_at: "2026-03-01T00:00:00Z",
  completed_at: "2026-03-10T00:00:00Z",
  steps: [
    { step_id: "s1", title: "Step 1", description: "", required: true, category: "paperwork", completed: true, completed_by: "u1", completed_at: "2026-03-10" },
  ],
};

const TEMPLATES = [
  { id: "obt_default_engineering", name: "Engineering Hire", department: "Engineering", steps: [] },
  { id: "obt_default_sales", name: "Sales Hire", department: "Sales", steps: [] },
];

const EMPLOYEES = [
  { id: "emp_1", full_name: "Jane Doe", department: "Engineering", status: "onboarding" },
  { id: "emp_3", full_name: "New Person", department: "Sales", status: "active" },
];

function stubDefaultFetches(instances = [ACTIVE_INSTANCE, COMPLETED_INSTANCE]) {
  fetchMock.mockImplementation((url: string) => {
    if (typeof url === "string" && url.includes("/api/people/onboarding/templates")) {
      return Promise.resolve({ ok: true, json: async () => ({ templates: TEMPLATES }) });
    }
    if (typeof url === "string" && url.includes("/api/people/onboarding")) {
      return Promise.resolve({ ok: true, json: async () => ({ instances }) });
    }
    if (typeof url === "string" && url.includes("/api/people/employees")) {
      return Promise.resolve({ ok: true, json: async () => ({ employees: EMPLOYEES }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
}

describe("OnboardingTab", () => {
  it("renders active onboarding cards with progress info", async () => {
    stubDefaultFetches();
    render(<OnboardingTab />);

    await waitFor(() => {
      expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    });
    expect(screen.getByText(/1\/3 steps/)).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-card")).toBeInTheDocument();
    expect(screen.getByTestId("progress-bar")).toBeInTheDocument();
  });

  it("expands a card and shows step checkboxes", async () => {
    stubDefaultFetches();
    render(<OnboardingTab />);

    await waitFor(() => {
      expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    });

    // Click the card to expand
    fireEvent.click(screen.getByText("Jane Doe"));

    await waitFor(() => {
      expect(screen.getByText("Sign offer letter")).toBeInTheDocument();
      expect(screen.getByText("Set up GitHub")).toBeInTheDocument();
      expect(screen.getByText("Meet the team")).toBeInTheDocument();
    });

    // s1 should be checked (completed)
    const checkbox1 = screen.getByTestId("step-checkbox-s1") as HTMLInputElement;
    expect(checkbox1.checked).toBe(true);

    // s2 should be unchecked
    const checkbox2 = screen.getByTestId("step-checkbox-s2") as HTMLInputElement;
    expect(checkbox2.checked).toBe(false);
  });

  it("clicking a step checkbox triggers a PATCH request", async () => {
    stubDefaultFetches();
    render(<OnboardingTab />);

    await waitFor(() => {
      expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    });

    // Expand
    fireEvent.click(screen.getByText("Jane Doe"));
    await waitFor(() => {
      expect(screen.getByTestId("step-checkbox-s2")).toBeInTheDocument();
    });

    // Mock the PATCH response
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          instance: {
            ...ACTIVE_INSTANCE,
            steps: ACTIVE_INSTANCE.steps.map((s) =>
              s.step_id === "s2" ? { ...s, completed: true, completed_by: "u1" } : s,
            ),
          },
        }),
      }),
    );

    // Click the unchecked step
    fireEvent.click(screen.getByTestId("step-checkbox-s2"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/people/onboarding/ob_1",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ step_id: "s2", action: "complete" }),
        }),
      );
    });
  });

  it("shows the Start New Onboarding form with dropdowns", async () => {
    stubDefaultFetches();
    render(<OnboardingTab />);

    await waitFor(() => {
      expect(screen.getByTestId("start-onboarding-btn")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("start-onboarding-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("start-onboarding-form")).toBeInTheDocument();
      expect(screen.getByTestId("employee-select")).toBeInTheDocument();
      expect(screen.getByTestId("template-select")).toBeInTheDocument();
    });

    // Employee dropdown should have our employees
    const empSelect = screen.getByTestId("employee-select");
    expect(empSelect).toHaveTextContent("Jane Doe");
    expect(empSelect).toHaveTextContent("New Person");

    // Template dropdown should have our templates
    const tmplSelect = screen.getByTestId("template-select");
    expect(tmplSelect).toHaveTextContent("Engineering Hire");
    expect(tmplSelect).toHaveTextContent("Sales Hire");
  });

  it("renders completed onboardings when toggled", async () => {
    stubDefaultFetches();
    render(<OnboardingTab />);

    await waitFor(() => {
      expect(screen.getByTestId("toggle-completed")).toBeInTheDocument();
    });

    expect(screen.getByText(/Show Completed \(1\)/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("toggle-completed"));

    await waitFor(() => {
      expect(screen.getByText("John Smith")).toBeInTheDocument();
      expect(screen.getByText("Completed")).toBeInTheDocument();
    });
    expect(screen.getByTestId("completed-card")).toBeInTheDocument();
  });

  it("renders empty state when no active onboardings", async () => {
    stubDefaultFetches([COMPLETED_INSTANCE]);
    render(<OnboardingTab />);

    await waitFor(() => {
      expect(screen.getByText(/No active onboardings/)).toBeInTheDocument();
    });
  });
});
