/**
 * buildAction tests: the action schema is derived from the tool, parameters are
 * redacted before anything is hashed, and the redactor hits become the PII and
 * secret signals. The security invariant is that no raw sensitive value ever
 * appears in the redacted snapshot or influences the hash in cleartext.
 */

import { buildAction } from "@/lib/ogiam/action";

describe("buildAction", () => {
  it("carries the tool metadata onto the action", () => {
    const { action } = buildAction({
      tool: "send_invoice",
      capability: "finance.write",
      isMutation: true,
      surface: "/assistant",
      workflowId: "wf-1",
      params: { amount: 100 },
    });
    expect(action.tool).toBe("send_invoice");
    expect(action.capability).toBe("finance.write");
    expect(action.isMutation).toBe(true);
    expect(action.surface).toBe("/assistant");
    expect(action.workflowId).toBe("wf-1");
    expect(typeof action.paramsHash).toBe("string");
    expect(action.paramsHash.length).toBe(64); // sha256 hex
  });

  it("flags PII in the parameters and never leaks the raw value", () => {
    const { action, redactedParams } = buildAction({
      tool: "create_note",
      capability: "*",
      isMutation: true,
      surface: "/assistant",
      params: { body: "call me at 415-555-0199 or me@example.com" },
    });
    expect(action.signals.piiDetected).toBe(true);
    expect(action.signals.secretDetected).toBe(false);
    expect(redactedParams).not.toContain("415-555-0199");
    expect(redactedParams).not.toContain("me@example.com");
  });

  it("flags a secret as secretDetected", () => {
    const { action, redactedParams } = buildAction({
      tool: "create_note",
      capability: "*",
      isMutation: true,
      surface: "/assistant",
      params: { note: "key sk-abcdefghijklmnopqrstuvwx12345678" },
    });
    expect(action.signals.secretDetected).toBe(true);
    expect(redactedParams).not.toContain("sk-abcdefghijklmnopqrstuvwx12345678");
  });

  it("is deterministic: same params hash the same regardless of key order", () => {
    const a = buildAction({
      tool: "t", capability: "*", isMutation: false, surface: "/assistant",
      params: { a: 1, b: 2 },
    });
    const b = buildAction({
      tool: "t", capability: "*", isMutation: false, surface: "/assistant",
      params: { b: 2, a: 1 },
    });
    expect(a.action.paramsHash).toBe(b.action.paramsHash);
  });
});
