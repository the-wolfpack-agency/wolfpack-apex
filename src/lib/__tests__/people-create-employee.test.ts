/**
 * createEmployee: re-adding a person by email REACTIVATES the existing row
 * (upsert) instead of failing on the UNIQUE(email) constraint. This is the
 * client need: people leave and rejoin, or get removed by mistake.
 */

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));
const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));

import { createEmployee } from "@/lib/people";

beforeEach(() => jest.clearAllMocks());

it("upserts on email (ON CONFLICT ... DO UPDATE) so a re-add cannot fail on the unique constraint", async () => {
  // Echo the inserted id back (a fresh insert).
  mockSafeQuery.mockImplementation((_sql: string, params: unknown[]) =>
    Promise.resolve({ rows: [{ id: params[0], full_name: params[1], email: params[2] }] }),
  );
  await createEmployee({ full_name: "Nick", email: "nick@x.com" }, "u1", "cto");
  const sql = mockSafeQuery.mock.calls[0][0] as string;
  expect(sql).toMatch(/ON CONFLICT \(email\) DO UPDATE/i);
  expect(mockTrack).toHaveBeenCalledWith(
    "hr.employee_added",
    "u1",
    "cto",
    expect.objectContaining({ reactivated: false }),
  );
});

it("reactivates the existing employee when the email already exists (returns that row, marks reactivated)", async () => {
  // The upsert hit an existing row: RETURNING gives back its (different) id.
  mockSafeQuery.mockResolvedValue({
    rows: [{ id: "emp_existing", full_name: "Nick", email: "nick@x.com", status: "onboarding" }],
  });
  const emp = await createEmployee({ full_name: "Nick", email: "nick@x.com" }, "u1", "cto");
  expect(emp.id).toBe("emp_existing"); // reused the existing person's row + history
  expect(mockTrack).toHaveBeenCalledWith(
    "hr.employee_added",
    "u1",
    "cto",
    expect.objectContaining({ employee_id: "emp_existing", reactivated: true }),
  );
});

it("still requires a full_name", async () => {
  await expect(createEmployee({ email: "x@y.com" }, "u1", "cto")).rejects.toThrow(/full_name/);
  expect(mockSafeQuery).not.toHaveBeenCalled();
});
