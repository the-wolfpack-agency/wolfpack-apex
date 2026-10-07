/** @jest-environment jsdom */
import "@testing-library/jest-dom";

/**
 * UI test for the Forcefield tenants page. Asserts the create flow POSTs, shows
 * the token + the ready-to-paste quick-start ONCE on success, renders the list,
 * and shows an inline error on failure. Auth + fetch are mocked.
 */
const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  getInstinctUser: () => ({ role: "cto" }),
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import ForcefieldTenantsPage from "../page";

const CREATED = {
  ok: true,
  tenant: { id: "t1", name: "Before U Trade", siteLabel: "beforeutrade", status: "active", createdAt: "2026-10-06T00:00:00Z" },
  token: "ff_realtoken123",
  quickstart: {
    token: "ff_realtoken123", ingestUrl: "https://x/api/site-analytics/ingest", rulesetUrl: "https://x/api/forcefield/ruleset",
    cloudflareEnv: { FORCEFIELD_SITE: "beforeutrade", SITE_ANALYTICS_INGEST_TOKEN: "ff_realtoken123", FORCEFIELD_ENFORCE: "off" },
    nextEnv: { FORCEFIELD_SITE: "beforeutrade", SITE_ANALYTICS_INGEST_TOKEN: "ff_realtoken123" },
    nextSnippet: 'export { default as middleware } from "@ogiam/forcefield/next";',
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ tenants: [] }) }); // initial list load
});

it("renders the onboard form and empty list", async () => {
  render(<ForcefieldTenantsPage />);
  expect(await screen.findByTestId("tenant-form")).toBeInTheDocument();
  expect(screen.getByTestId("t-submit")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText(/No tenants yet/i)).toBeInTheDocument());
});

it("issues a key and shows the token + quick-start once", async () => {
  render(<ForcefieldTenantsPage />);
  await screen.findByTestId("tenant-form");
  fireEvent.change(screen.getByTestId("t-name"), { target: { value: "Before U Trade" } });
  fireEvent.change(screen.getByTestId("t-site"), { target: { value: "beforeutrade" } });
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => CREATED }); // the POST
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ tenants: [CREATED.tenant] }) }); // reload
  fireEvent.click(screen.getByTestId("t-submit"));
  const panel = await screen.findByTestId("t-created");
  expect(panel).toHaveTextContent("Before U Trade is onboarded");
  expect(screen.getByTestId("t-token")).toHaveTextContent("ff_realtoken123");
  // the quick-start env carries the token + site, enforcement off
  expect(panel).toHaveTextContent("SITE_ANALYTICS_INGEST_TOKEN=ff_realtoken123");
  expect(panel).toHaveTextContent("FORCEFIELD_ENFORCE=off");
  expect(panel).toHaveTextContent("@ogiam/forcefield/next");
});

it("shows an inline error on a failed create, no token panel", async () => {
  render(<ForcefieldTenantsPage />);
  await screen.findByTestId("tenant-form");
  fireEvent.change(screen.getByTestId("t-name"), { target: { value: "x" } });
  fireEvent.change(screen.getByTestId("t-site"), { target: { value: "y" } });
  mockFetch.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ ok: false, error: "invalid_name_or_site" }) });
  fireEvent.click(screen.getByTestId("t-submit"));
  expect(await screen.findByTestId("t-error")).toHaveTextContent(/client name and a site label/i);
  expect(screen.queryByTestId("t-created")).not.toBeInTheDocument();
});

// --- token lifecycle: disable (kill a leaked token) + rotate --------------------

const ACTIVE_TENANT = { id: "t1", name: "Before U Trade", siteLabel: "beforeutrade", status: "active", createdAt: "2026-10-06T00:00:00Z" };

it("disables a tenant (kills a leaked token) and reloads", async () => {
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ tenants: [ACTIVE_TENANT] }) }); // initial list
  render(<ForcefieldTenantsPage />);
  const disable = await screen.findByTestId("tn-disable-t1");
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, status: "disabled" }) }); // POST manage
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ tenants: [{ ...ACTIVE_TENANT, status: "disabled" }] }) }); // reload
  fireEvent.click(disable);
  await waitFor(() => {
    const call = mockFetch.mock.calls.find((c) => String(c[0]).includes("/tenants/manage"));
    expect(call).toBeTruthy();
    expect((call![1] as RequestInit).body).toContain("disable");
  });
});

it("rotate shows the new token once", async () => {
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ tenants: [ACTIVE_TENANT] }) }); // initial list
  render(<ForcefieldTenantsPage />);
  const rotate = await screen.findByTestId("tn-rotate-t1");
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, token: "ff_rotated999" }) }); // POST rotate
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ tenants: [ACTIVE_TENANT] }) }); // reload
  fireEvent.click(rotate);
  const panel = await screen.findByTestId("tn-rotated");
  expect(panel).toHaveTextContent(/new token issued/i);
  expect(screen.getByTestId("tn-rotated-token")).toHaveTextContent("ff_rotated999");
});

it("licenses a client by choosing a plan (manual billing path)", async () => {
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ tenants: [ACTIVE_TENANT] }) }); // initial list
  render(<ForcefieldTenantsPage />);
  const sel = await screen.findByTestId("tn-plan-t1");
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, billing: { plan: "growth", status: "active" } }) }); // POST billing
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ tenants: [{ ...ACTIVE_TENANT, plan: "growth", subscriptionStatus: "active" }] }) }); // reload
  fireEvent.change(sel, { target: { value: "growth" } });
  await waitFor(() => {
    const call = mockFetch.mock.calls.find((c) => String(c[0]).includes("/tenants/billing"));
    expect(call).toBeTruthy();
    const b = JSON.parse(String((call![1] as RequestInit).body));
    expect(b).toMatchObject({ id: "t1", plan: "growth", status: "active" });
  });
});

it("toggles shared-intel participation for a tenant", async () => {
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ tenants: [{ ...ACTIVE_TENANT, sharesIntel: true }] }) }); // initial
  render(<ForcefieldTenantsPage />);
  const btn = await screen.findByTestId("tn-intel-t1");
  expect(btn).toHaveTextContent(/intel: on/i);
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, sharesIntel: false }) }); // POST intel_off
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ tenants: [{ ...ACTIVE_TENANT, sharesIntel: false }] }) }); // reload
  fireEvent.click(btn);
  await waitFor(() => {
    const call = mockFetch.mock.calls.find((c) => String((c[1] as RequestInit)?.body).includes("intel_off"));
    expect(call).toBeTruthy();
  });
});
