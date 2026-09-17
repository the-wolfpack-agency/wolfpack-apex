/**
 * tenantIdFor - pure slug logic, and a guard on the ReDoS fix: a pathological
 * input returns promptly and produces a valid, bounded, letter-led slug.
 */
import { tenantIdFor } from "../registry";
import { isValidTenantId } from "@/lib/db/tenant";

it("slugifies an org name to a letter-led, dashed id", () => {
  const id = tenantIdFor("Acme Inc");
  expect(id.startsWith("acme")).toBe(true);
  expect(isValidTenantId(id)).toBe(true);
});

it("prefixes a non-letter-led name so the id stays letter-led", () => {
  const id = tenantIdFor("123 Motors");
  expect(id[0]).toBe("t");
  expect(isValidTenantId(id)).toBe(true);
});

it("never emits leading/trailing dashes and stays a valid id for junk input", () => {
  for (const junk of ["   ", "!!!", "---", "@@@ !!!", ""]) {
    const id = tenantIdFor(junk);
    expect(id.startsWith("-")).toBe(false);
    expect(id.endsWith("-")).toBe(false);
    expect(isValidTenantId(id)).toBe(true);
  }
});

it("returns promptly on a pathological input (ReDoS guard)", () => {
  const evil = "-".repeat(100000) + " " + "a".repeat(100000);
  const start = process.hrtime.bigint();
  const id = tenantIdFor(evil);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  expect(isValidTenantId(id)).toBe(true);
  expect(ms).toBeLessThan(100); // linear pass, not polynomial backtracking
});

it("is deterministic for the same name", () => {
  expect(tenantIdFor("Acme Inc")).toBe(tenantIdFor("Acme Inc"));
});
