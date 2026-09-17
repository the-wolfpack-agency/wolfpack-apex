/**
 * requireEntitlement guard - resolveEntitlement mocked. Proves it returns null
 * (proceed) when the product is enabled and a 403 NextResponse when disabled.
 */
const mockResolve = jest.fn();
jest.mock("../entitlements", () => ({ resolveEntitlement: (...a: unknown[]) => mockResolve(...a) }));

import { requireEntitlement } from "../require-entitlement";

beforeEach(() => jest.clearAllMocks());

it("returns null (proceed) when the product is enabled", async () => {
  mockResolve.mockResolvedValue(true);
  expect(await requireEntitlement("w1", "forcefield")).toBeNull();
  expect(mockResolve).toHaveBeenCalledWith("w1", "forcefield");
});

it("returns a 403 with the feature name when disabled", async () => {
  mockResolve.mockResolvedValue(false);
  const res = await requireEntitlement("w1", "secure_agent");
  expect(res).not.toBeNull();
  expect(res!.status).toBe(403);
  const body = await res!.json();
  expect(body.entitled).toBe(false);
  expect(body.feature).toBe("secure_agent");
});
