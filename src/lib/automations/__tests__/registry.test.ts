/**
 * Tests for the automations registry — every registered entry must
 * satisfy the contract.
 */

import {
  getAutomation,
  listAutomations,
  listAutomationMetadata,
} from "@/lib/automations/registry";

describe("automations registry", () => {
  it("returns at least the porsche-classes entry", () => {
    const all = listAutomations();
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all.find((a) => a.id === "porsche-classes")).toBeDefined();
  });

  it("getAutomation returns null for unknown ids", () => {
    expect(getAutomation("does-not-exist")).toBeNull();
  });

  it("getAutomation returns the matching definition", () => {
    const a = getAutomation("porsche-classes");
    expect(a).not.toBeNull();
    expect(a?.id).toBe("porsche-classes");
    expect(a?.parsers.porsche_xlsx).toBeDefined();
  });

  it("metadata projection is plain JSON-safe (no parser closures)", () => {
    const meta = listAutomationMetadata();
    for (const m of meta) {
      expect(typeof m.id).toBe("string");
      expect(typeof m.name).toBe("string");
      expect(Array.isArray(m.source_types)).toBe(true);
      // Should not leak the parser function on the wire.
      expect((m as unknown as { parsers?: unknown }).parsers).toBeUndefined();
    }
  });

  it("porsche-classes registers porsche_xlsx parser at minimum (Stream A scope)", () => {
    const a = getAutomation("porsche-classes");
    expect(Object.keys(a!.parsers)).toContain("porsche_xlsx");
  });
});
