/**
 * Promotion safety check: a procedure is shareable only if every step is still
 * allowed under the current OGIAM policy. This is the anti-poisoning gate.
 */

import { verifyProcedureForPromotion } from "@/lib/agents/memory/promote";
import { registerTool, __resetRegistryForTests } from "@/lib/assistant/tools/registry";
import { z } from "zod";

function tool(name: string, mutation = false) {
  registerTool({
    name,
    description: name,
    capability: "*",
    requiresConfirmation: mutation,
    paramSchema: z.object({}).passthrough(),
    matchIntent: () => null,
    handler: async () => ({ ok: true as const, data: {}, answer: "ok", sources: [] }),
  });
}

beforeEach(() => {
  __resetRegistryForTests();
  tool("read_status", false);
  tool("delete_records", true);
});

describe("verifyProcedureForPromotion", () => {
  it("promotes a plan whose every step is an allowed read", () => {
    const v = verifyProcedureForPromotion([
      { instruction: "show status", tool: "read_status" },
      { instruction: "small talk", tool: null },
    ]);
    expect(v.safe).toBe(true);
    expect(v.reason).toBeNull();
  });

  it("refuses a plan containing a step that the gate would now block", () => {
    const v = verifyProcedureForPromotion([
      { instruction: "show status", tool: "read_status" },
      { instruction: "delete the records", tool: "delete_records" },
    ]);
    expect(v.safe).toBe(false);
    expect(v.reason).toMatch(/delete_records/);
  });

  it("refuses a plan whose tool no longer exists (stale or removed)", () => {
    const v = verifyProcedureForPromotion([{ instruction: "do x", tool: "gone_tool" }]);
    expect(v.safe).toBe(false);
    expect(v.reason).toMatch(/no longer exists/);
  });
});
