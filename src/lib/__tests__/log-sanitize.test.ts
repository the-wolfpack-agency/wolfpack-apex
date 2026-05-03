import { sanitizeForLog } from "../log-sanitize";

describe("sanitizeForLog (CodeQL js/log-injection guard)", () => {
  it("returns empty string for null / undefined", () => {
    expect(sanitizeForLog(null)).toBe("");
    expect(sanitizeForLog(undefined)).toBe("");
  });

  it("strips CR + LF + TAB so attackers cannot forge log entries", () => {
    const forged = "user\r\n[admin] login OK";
    const out = sanitizeForLog(forged);
    expect(out).not.toContain("\r");
    expect(out).not.toContain("\n");
    expect(out).toBe("user[admin] login OK");
  });

  it("strips C0 control bytes (incl. NUL, ESC) and DEL", () => {
    const evil = "before\x00\x07\x1b[31mred\x1b[0m\x7fafter";
    const out = sanitizeForLog(evil);
    expect(/[\x00-\x1f\x7f]/.test(out)).toBe(false);
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  it("caps length at the requested max", () => {
    const huge = "x".repeat(10_000);
    expect(sanitizeForLog(huge).length).toBe(200);
    expect(sanitizeForLog(huge, 50).length).toBe(50);
  });

  it("preserves printable ASCII unchanged", () => {
    const s = 'unknown nav href: "/foo/bar?x=1"';
    expect(sanitizeForLog(s)).toBe(s);
  });

  it("coerces non-strings via String()", () => {
    expect(sanitizeForLog(42)).toBe("42");
    expect(sanitizeForLog({ a: 1 })).toBe("[object Object]");
  });
});
