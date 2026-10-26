/** @jest-environment jsdom */
import "@testing-library/jest-dom";

/**
 * UI test for the Forcefield Exposure panel: loads through fetchWithRefresh,
 * renders findings with their CVEs, an explicit empty state, an explicit
 * switched-off state, an explicit error state, and the outside-in scope line in
 * every state.
 */
const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({ fetchWithRefresh: (...a: unknown[]) => mockFetchWithRefresh(...a) }));

import { render, screen } from "@testing-library/react";
import { ExposurePanel } from "../ExposurePanel";

const resp = (status: number, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
const KEV = { catalogVersion: "2026.10.23", dateReleased: "2026-10-23T00:00:00Z" };
const SCOPE = "Outside-in exposure monitoring of verified targets. Forcefield does not sit in front of these appliances and does not protect them.";
const FINDING = {
  id: "f1", platform: "client-x", route: "/", severity: "critical", title: "Internet-facing portal with known-exploited CVEs",
  status: "open", vendor: "Ivanti", product: "ivanti_connect_secure", cveIds: ["CVE-2025-0282", "CVE-2024-21887"], knownRansomware: true, createdAt: "x",
};

beforeEach(() => jest.clearAllMocks());

it("renders findings with CVEs, the KEV version and the scope line", async () => {
  mockFetchWithRefresh.mockResolvedValueOnce(resp(200, { enabled: true, kev: KEV, scope: SCOPE, findings: [FINDING] }));
  render(<ExposurePanel />);
  expect(await screen.findAllByTestId("exposure-row")).toHaveLength(1);
  expect(screen.getByTestId("exposure-cves")).toHaveTextContent("CVE-2025-0282, CVE-2024-21887");
  expect(screen.getByTestId("exposure-kev-version")).toHaveTextContent("2026.10.23");
  expect(screen.getByTestId("exposure-scope")).toHaveTextContent(/does not protect them/);
  expect(screen.getByText(/ransomware campaigns/)).toBeInTheDocument();
  expect(mockFetchWithRefresh).toHaveBeenCalledWith("/api/admin/forcefield/exposure");
});

it("explicit empty state when enabled with no findings", async () => {
  mockFetchWithRefresh.mockResolvedValueOnce(resp(200, { enabled: true, kev: KEV, scope: SCOPE, findings: [] }));
  render(<ExposurePanel />);
  expect(await screen.findByTestId("exposure-empty")).toHaveTextContent(/No exposed edge devices/);
  expect(screen.queryByTestId("exposure-list")).not.toBeInTheDocument();
});

it("explicit switched-off state when disabled", async () => {
  mockFetchWithRefresh.mockResolvedValueOnce(resp(200, { enabled: false, kev: KEV, scope: SCOPE, findings: [] }));
  render(<ExposurePanel />);
  expect(await screen.findByTestId("exposure-disabled")).toHaveTextContent(/switched off/);
});

it("explicit error state on a failed load, scope line still shown", async () => {
  mockFetchWithRefresh.mockResolvedValueOnce(resp(500));
  render(<ExposurePanel />);
  expect(await screen.findByTestId("exposure-error")).toBeInTheDocument();
  expect(screen.getByTestId("exposure-scope")).toHaveTextContent(/does not protect them/);
});

it("a thrown fetch is an error state, never a blank panel", async () => {
  mockFetchWithRefresh.mockRejectedValueOnce(new Error("network"));
  render(<ExposurePanel />);
  expect(await screen.findByTestId("exposure-error")).toBeInTheDocument();
});
