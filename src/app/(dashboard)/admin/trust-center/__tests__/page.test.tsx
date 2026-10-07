/** @jest-environment jsdom */
import "@testing-library/jest-dom";

/**
 * UI test for the Trust Center. Proves it renders the honest sections (incl. the
 * controls-vs-stamp philosophy and the "not yet certified" status), each with a
 * deep-link to the live evidence, and fires the reviewer-interest signal. Auth +
 * fetch mocked.
 */
const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  getInstinctUser: () => ({ role: "cto" }),
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));

import { render, screen, waitFor } from "@testing-library/react";
import TrustCenterPage from "../page";

beforeEach(() => { jest.clearAllMocks(); mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) }); });

it("renders the honest sections and their evidence links", async () => {
  render(<TrustCenterPage />);
  expect(await screen.findByTestId("trust-center")).toBeInTheDocument();
  // the honest posture is stated, not hidden
  expect(screen.getByText(/Aligned, not yet certified/i)).toBeInTheDocument();
  expect(screen.getByTestId("trust-certifications")).toHaveTextContent(/not currently certified/i);
  expect(screen.getByTestId("trust-philosophy")).toHaveTextContent(/separate the controls from the stamp/i);
  // AI core is deterministic, stated plainly
  expect(screen.getByTestId("trust-ai-governance")).toHaveTextContent(/deterministic/i);
  // evidence deep-links point at the live compliance report
  expect(screen.getByTestId("trust-self-testing-evidence")).toHaveAttribute("href", "/admin/compliance");
});

it("fires the trust_center_viewed reviewer-interest signal on mount", async () => {
  render(<TrustCenterPage />);
  await waitFor(() => {
    const call = mockFetch.mock.calls.find((c) => String(c[0]).includes("/api/analytics"));
    expect(call).toBeTruthy();
    expect((call![1] as RequestInit).body).toContain("forcefield.trust_center_viewed");
  });
});
