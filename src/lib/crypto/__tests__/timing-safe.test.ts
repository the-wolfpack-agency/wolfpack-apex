/**
 * The one timing-safe string-compare primitive + the bearer-auth helper that
 * wraps it. These back the CWE-208 fix: ~35 routes used to compare a bearer
 * secret with `===`, a timing-unsafe compare, each inline. The primitive is now
 * the single implementation.
 */
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { isAuthorizedBearer } from "@/lib/auth/bearer-auth";

describe("timingSafeEqualStr", () => {
  it("true for equal strings", () => {
    expect(timingSafeEqualStr("s3cret-token", "s3cret-token")).toBe(true);
  });
  it("false for different same-length strings", () => {
    expect(timingSafeEqualStr("abcdef", "abcxyz")).toBe(false);
  });
  it("false (never throws) on a length mismatch", () => {
    expect(timingSafeEqualStr("short", "a-much-longer-value")).toBe(false);
  });
  it("false on empty vs non-empty", () => {
    expect(timingSafeEqualStr("", "x")).toBe(false);
  });
  it("true on empty vs empty", () => {
    expect(timingSafeEqualStr("", "")).toBe(true);
  });
  it("handles multi-byte UTF-8 without throwing", () => {
    expect(timingSafeEqualStr("café", "café")).toBe(true);
    expect(timingSafeEqualStr("café", "cafe")).toBe(false); // different byte length
  });
  it("false on non-string input (runtime defense)", () => {
    // @ts-expect-error - deliberately passing a non-string to prove the guard
    expect(timingSafeEqualStr(null, "x")).toBe(false);
  });
});

describe("isAuthorizedBearer", () => {
  const secret = "cron-secret-value-123456";
  it("true when the header presents the exact bearer secret", () => {
    expect(isAuthorizedBearer(`Bearer ${secret}`, secret)).toBe(true);
  });
  it("false on a wrong secret", () => {
    expect(isAuthorizedBearer(`Bearer wrong-value-000000`, secret)).toBe(false);
  });
  it("false when the header is missing (null/undefined)", () => {
    expect(isAuthorizedBearer(null, secret)).toBe(false);
    expect(isAuthorizedBearer(undefined, secret)).toBe(false);
  });
  it("false when the scheme is missing (bare secret, no 'Bearer ')", () => {
    expect(isAuthorizedBearer(secret, secret)).toBe(false);
  });
  it("false when the secret is unset/empty (an unconfigured route authorizes no one)", () => {
    expect(isAuthorizedBearer(`Bearer ${secret}`, undefined)).toBe(false);
    expect(isAuthorizedBearer(`Bearer `, "")).toBe(false);
  });
});
