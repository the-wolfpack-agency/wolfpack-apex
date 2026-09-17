/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
const mockFetch = jest.fn();
let user: unknown = { role: "cto" };
jest.mock("@/lib/client-auth", () => ({
  getInstinctUser: () => user,
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "content-type": "application/json" }),
}));

import SelfServeAdminPage from "../page";

function resp(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}
let ents: unknown[] = [];
let tenants: unknown[] = [];
function routed() {
  mockFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
    const method = opts?.method ?? "GET";
    if (url.includes("/entitlements")) return method === "POST" ? resp(200, { ok: true }) : resp(200, { entitlements: ents });
    if (url.includes("/tenants")) return method === "POST" ? resp(200, { ok: true }) : resp(200, { tenants });
    return resp(404, {});
  });
}
const FF = { key: "forcefield", label: "Forcefield", description: "protect", envDefault: true, override: null, effective: true };
const PENDING = { tenant_id: "t-acme-ab12", org_name: "Acme", status: "pending_provision", has_db: false, admin_email: "a@acme.com", created_at: "2026-09-17" };

beforeEach(() => { jest.clearAllMocks(); user = { role: "cto" }; ents = [FF]; tenants = [PENDING]; routed(); });

test("redirects an unauthenticated user", () => {
  user = null;
  render(<SelfServeAdminPage />);
  expect(mockPush).toHaveBeenCalledWith("/login?next=/admin/self-serve");
  expect(screen.queryByTestId("self-serve-admin")).not.toBeInTheDocument();
});

test("renders products with their effective state", async () => {
  render(<SelfServeAdminPage />);
  await waitFor(() => expect(screen.getByTestId("ent-list")).toBeInTheDocument());
  expect(screen.getByText("Forcefield")).toBeInTheDocument();
  expect(screen.getByText("On")).toBeInTheDocument();
});

test("disabling a product POSTs enabled=false to the entitlements API", async () => {
  render(<SelfServeAdminPage />);
  await waitFor(() => expect(screen.getByTestId("ent-disable-forcefield")).toBeInTheDocument());
  await act(async () => { fireEvent.click(screen.getByTestId("ent-disable-forcefield")); });
  const post = mockFetch.mock.calls.find((c) => String(c[0]).includes("/entitlements") && (c[1] as { method?: string })?.method === "POST");
  expect(post).toBeTruthy();
  expect(JSON.parse((post![1] as { body: string }).body)).toEqual({ feature: "forcefield", enabled: false });
});

test("attaches a DB to a pending tenant (connection string in the POST, never shown)", async () => {
  render(<SelfServeAdminPage />);
  await waitFor(() => expect(screen.getByTestId("tenant-conn-t-acme-ab12")).toBeInTheDocument());
  fireEvent.change(screen.getByTestId("tenant-conn-t-acme-ab12"), { target: { value: "postgres://secret@h/db" } });
  await act(async () => { fireEvent.click(screen.getByTestId("tenant-attach-t-acme-ab12")); });
  const post = mockFetch.mock.calls.find((c) => String(c[0]).includes("/tenants") && (c[1] as { method?: string })?.method === "POST");
  expect(JSON.parse((post![1] as { body: string }).body)).toEqual({ tenantId: "t-acme-ab12", connectionString: "postgres://secret@h/db" });
});

test("an active tenant shows attached, not an input", async () => {
  tenants = [{ ...PENDING, status: "active", has_db: true }];
  render(<SelfServeAdminPage />);
  await waitFor(() => expect(screen.getByTestId("tenant-has-db")).toBeInTheDocument());
  expect(screen.queryByTestId("tenant-attach-t-acme-ab12")).not.toBeInTheDocument();
});
