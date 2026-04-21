/**
 * Formatter for the North Star tile. Regression: "1000.0M $" was
 * being rendered instead of "$1.0B" for a $1B revenue target because
 * (a) formatValue topped out at M, and (b) currency symbols dangled
 * after the number instead of prefixing.
 */

import { formatValue, formatValueWithUnit } from "@/components/goals/NorthStarTile";

describe("formatValue", () => {
  test("scales trillions", () => {
    expect(formatValue(2_500_000_000_000)).toBe("2.5T");
  });
  test("scales billions — the $1B bug", () => {
    expect(formatValue(1_000_000_000)).toBe("1.0B");
    expect(formatValue(3_200_000_000)).toBe("3.2B");
  });
  test("scales millions", () => {
    expect(formatValue(1_500_000)).toBe("1.5M");
  });
  test("scales thousands", () => {
    expect(formatValue(2_500)).toBe("2.5k");
  });
  test("prints plain integer when small", () => {
    expect(formatValue(42)).toBe("42");
  });
  test("handles negatives via abs-threshold", () => {
    expect(formatValue(-1_000_000_000)).toBe("-1.0B");
  });
});

describe("formatValueWithUnit", () => {
  test("prefixes $ for currency", () => {
    expect(formatValueWithUnit(1_000_000_000, "$")).toBe("$1.0B");
  });
  test("prefixes common currency symbols + codes", () => {
    expect(formatValueWithUnit(1_000_000, "€")).toBe("€1.0M");
    expect(formatValueWithUnit(5_000, "USD")).toBe("USD5.0k");
  });
  test("appends non-currency units with a space", () => {
    expect(formatValueWithUnit(1_500, "qps")).toBe("1.5k qps");
    expect(formatValueWithUnit(42, "customers")).toBe("42 customers");
  });
  test("no unit → plain value", () => {
    expect(formatValueWithUnit(100, null)).toBe("100");
    expect(formatValueWithUnit(100, "")).toBe("100");
  });
});
