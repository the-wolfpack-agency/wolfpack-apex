/** Shared tool role gate. */
import { canInvokeTool } from "@/lib/assistant/tools/gate";

describe("canInvokeTool", () => {
  it("opens '*' to any authenticated principal", () => {
    expect(canInvokeTool("ops", "*")).toBe(true);
    expect(canInvokeTool("anything", "*")).toBe(true);
  });
  it("allows when the role ranks at or above the requirement", () => {
    expect(canInvokeTool("cto", "cto")).toBe(true);
    expect(canInvokeTool("ceo", "dev")).toBe(true);
  });
  it("denies when the role ranks below the requirement", () => {
    expect(canInvokeTool("ops", "cto")).toBe(false);
    expect(canInvokeTool("sales", "dev")).toBe(false);
  });
  it("treats an unknown role as least privilege", () => {
    expect(canInvokeTool("nobody", "dev")).toBe(false);
    expect(canInvokeTool("nobody", "*")).toBe(true);
  });
  it("is case-insensitive on the role", () => {
    expect(canInvokeTool("CTO", "cto")).toBe(true);
  });
});
