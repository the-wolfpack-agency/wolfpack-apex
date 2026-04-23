/**
 * @jest-environment jsdom
 *
 * InsightsTab — grouped view. Feeds mixed-category insight data to the
 * component and asserts:
 *   - Group headings render for each distinct bucket
 *   - First group is expanded by default, the rest collapsed
 *   - Clicking a collapsed group header expands it and fires the
 *     `hr.insights.group_expanded` analytics event
 *   - Exported pure `groupInsights` helper partitions + orders correctly
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const fetchMock = jest.fn();

jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...args: unknown[]) => fetchMock(...args),
}));

jest.mock("@/components/people/auth", () => ({
  authHeaders: () => ({}),
}));

const MIXED_INSIGHTS = [
  { id: "i1", category: "compliance", severity: "attention", title: "I-9 missing for 2 hires", body: "Collect forms this week.", status: "open", created_at: "2026-04-01" },
  { id: "i2", category: "benefits", severity: "info", title: "Open enrollment starts Nov 1", body: "Update plan library.", status: "open", created_at: "2026-04-02" },
  { id: "i3", category: "onboarding", severity: "info", title: "Sarah at 80% checklist", body: "3 items remain.", status: "open", created_at: "2026-04-02" },
  { id: "i4", category: "compensation", severity: "attention", title: "Payroll variance vs. last cycle", body: "Investigate.", status: "open", created_at: "2026-04-03" },
  { id: "i5", category: "benefits", severity: "critical", title: "HSA plan rate jump 18%", body: "Review with broker.", status: "open", created_at: "2026-04-04" },
  { id: "i6", category: "documents", severity: "info", title: "W-4 extracted for 3 docs", body: "Fields available for review.", status: "open", created_at: "2026-04-05" },
];

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => {
    if (typeof url === "string" && url.startsWith("/api/people/insights")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ insights: MIXED_INSIGHTS }),
      } as Response);
    }
    // analytics endpoint + anything else — benign 200.
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true }),
    } as Response);
  });
});

async function renderTab() {
  const mod = await import("@/components/people/InsightsTab");
  const { InsightsTab } = mod;
  await act(async () => {
    render(<InsightsTab />);
  });
  await waitFor(() => {
    expect(screen.getByText(/Insights \(/)).toBeInTheDocument();
  });
}

test("groupInsights helper partitions + orders correctly", async () => {
  const { groupInsights } = await import("@/components/people/InsightsTab");
  const grouped = groupInsights(MIXED_INSIGHTS);
  const labels = grouped.map((g) => g.label);
  // Predefined ordering: Compensation > Benefits > Onboarding > Compliance & Documents
  expect(labels).toEqual([
    "Compensation",
    "Benefits",
    "Onboarding",
    "Compliance & Documents",
  ]);
  // Compliance & Documents bucket must contain both the raw `compliance`
  // and raw `documents` rows — that's the whole point of the mapping.
  const compliance = grouped.find((g) => g.label === "Compliance & Documents");
  expect(compliance).toBeDefined();
  const ids = compliance!.items.map((i) => i.id).sort();
  expect(ids).toEqual(["i1", "i6"]);
});

test("renders one heading per distinct group + defaults first open, rest collapsed", async () => {
  await renderTab();
  await waitFor(() => {
    expect(screen.getByTestId("insights-grouped")).toBeInTheDocument();
  });

  // All 4 group headers render.
  const compensation = screen.getByTestId("insights-group-header-compensation");
  const benefits = screen.getByTestId("insights-group-header-benefits");
  const onboarding = screen.getByTestId("insights-group-header-onboarding");
  const compliance = screen.getByTestId("insights-group-header-compliance-&-documents");
  expect(compensation).toBeInTheDocument();
  expect(benefits).toBeInTheDocument();
  expect(onboarding).toBeInTheDocument();
  expect(compliance).toBeInTheDocument();

  // First group is expanded (aria-expanded=true), others collapsed.
  expect(compensation.getAttribute("aria-expanded")).toBe("true");
  expect(benefits.getAttribute("aria-expanded")).toBe("false");
  expect(onboarding.getAttribute("aria-expanded")).toBe("false");
  expect(compliance.getAttribute("aria-expanded")).toBe("false");

  // Insight body from first group is visible, from other groups is not.
  expect(screen.getByText(/Payroll variance vs\. last cycle/)).toBeInTheDocument();
  expect(screen.queryByText(/HSA plan rate jump/)).not.toBeInTheDocument();
});

test("clicking a collapsed header expands it and fires hr.insights.group_expanded", async () => {
  await renderTab();

  const benefits = await screen.findByTestId("insights-group-header-benefits");
  expect(benefits.getAttribute("aria-expanded")).toBe("false");

  await act(async () => {
    fireEvent.click(benefits);
  });

  await waitFor(() => {
    expect(benefits.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/HSA plan rate jump/)).toBeInTheDocument();
  });

  // Analytics event fired (among many fetch calls, at least one carries
  // hr.insights.group_expanded).
  const analyticsCall = fetchMock.mock.calls.find((c) => {
    if (typeof c[0] !== "string" || c[0] !== "/api/analytics") return false;
    const init = c[1] as RequestInit | undefined;
    const body = typeof init?.body === "string" ? init.body : "";
    return body.includes("hr.insights.group_expanded");
  });
  expect(analyticsCall).toBeDefined();
});
