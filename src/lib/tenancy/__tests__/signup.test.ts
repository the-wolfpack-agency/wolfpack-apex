/**
 * Self-serve signup flow - registry + provider mocked, no DB, no network. Proves
 * validation, the default pending_provision path (no client mixed into shared
 * data), the active path when a provider returns a connection string, and the
 * duplicate-org guard.
 */
const mockRegister = jest.fn();
const mockSetConn = jest.fn();
const mockGetTenant = jest.fn();
const mockCreate = jest.fn();
const mockProvisioningEnabled = jest.fn();

jest.mock("@/lib/tenancy/registry", () => ({
  registerTenant: (...a: unknown[]) => mockRegister(...a),
  setTenantConnection: (...a: unknown[]) => mockSetConn(...a),
  getTenant: (...a: unknown[]) => mockGetTenant(...a),
  tenantIdFor: (name: string) => `t-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-xxxx`,
}));
jest.mock("@/lib/tenancy/provision-db", () => ({
  activeProvider: () => ({ id: "manual", create: (...a: unknown[]) => mockCreate(...a) }),
  provisioningEnabled: () => mockProvisioningEnabled(),
}));

import { signupTenant } from "../signup";

beforeEach(() => {
  jest.clearAllMocks();
  mockGetTenant.mockResolvedValue(null);
  mockRegister.mockResolvedValue(true);
  mockSetConn.mockResolvedValue(true);
  mockCreate.mockResolvedValue({ pending: true });
  mockProvisioningEnabled.mockReturnValue(false);
});

it("rejects a missing org name (no registration attempted)", async () => {
  const r = await signupTenant({ orgName: " ", adminEmail: "a@b.com" });
  expect(r.ok).toBe(false);
  expect(r.error).toBe("org_name");
  expect(mockRegister).not.toHaveBeenCalled();
});

it("rejects an invalid admin email", async () => {
  const r = await signupTenant({ orgName: "Acme Inc", adminEmail: "not-an-email" });
  expect(r.ok).toBe(false);
  expect(r.error).toBe("admin_email");
});

it.each(["a@b", "@acme.com", "a b@acme.com", "a@@b.com", "x".repeat(400) + "@a.co"])(
  "rejects the malformed email %p",
  async (bad) => {
    const r = await signupTenant({ orgName: "Acme Inc", adminEmail: bad });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("admin_email");
  },
);

it("default (no provider): registers the tenant and leaves it pending_provision", async () => {
  const r = await signupTenant({ orgName: "Acme Inc", adminEmail: "Admin@Acme.com" });
  expect(r.ok).toBe(true);
  expect(r.status).toBe("pending_provision");
  expect(mockRegister).toHaveBeenCalledWith(expect.objectContaining({ orgName: "Acme Inc", adminEmail: "admin@acme.com" }));
  expect(mockSetConn).not.toHaveBeenCalled(); // nothing provisioned, nothing mixed in
});

it("provider returns a connection string: marks the tenant active", async () => {
  mockProvisioningEnabled.mockReturnValue(true);
  mockCreate.mockResolvedValue({ pending: false, connectionString: "postgres://x" });
  const r = await signupTenant({ orgName: "Acme Inc", adminEmail: "a@acme.com" });
  expect(r.ok).toBe(true);
  expect(r.status).toBe("active");
  expect(mockSetConn).toHaveBeenCalledWith(expect.stringContaining("t-acme"), "postgres://x");
});

it("duplicate org is refused before registering", async () => {
  mockGetTenant.mockResolvedValue({ tenant_id: "t-acme-inc-xxxx" });
  const r = await signupTenant({ orgName: "Acme Inc", adminEmail: "a@acme.com" });
  expect(r.ok).toBe(false);
  expect(r.error).toBe("exists");
  expect(mockRegister).not.toHaveBeenCalled();
});
