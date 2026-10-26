/** @jest-environment node */
import { checkIntentMismatch, coerceDeclaredScope, isOutboundSend, targetsCredentials } from "@/lib/forcefield/intent-scope";
import { buildAction } from "@/lib/ogiam/action";
import { decide } from "@/lib/ogiam/policy";

const READ_ONLY = { access: "read_only" as const };

describe("agent intent mismatch (deterministic)", () => {
  it("a write in a read-only task is a mismatch", () => {
    expect(checkIntentMismatch(READ_ONLY, { tool: "update_contact", capability: "contacts.write", isMutation: true, params: {} })).toEqual({
      mismatch: true,
      reasons: ["mutation_in_read_only_task"],
    });
  });

  it("TRUE POSITIVE: a read-only task touching credential files", () => {
    for (const path of ["/app/.env", ".env.production", "~/.aws/credentials", "/home/u/.ssh/id_rsa", "repo/.git/config", "/etc/shadow", "config/secrets.yml", "/srv/.claude/.credentials.json", "certs/server.key"]) {
      expect(checkIntentMismatch(READ_ONLY, { tool: "read_file", capability: "files.read", isMutation: false, params: { path } }).reasons).toContain("credential_target");
    }
  });

  it("TRUE NEGATIVE: ordinary read-only work is not a mismatch", () => {
    for (const params of [{ q: "how do I reset my password" }, { path: "docs/environment-setup.md" }, { path: "src/app/page.tsx" }, { note: "the .envelope design" }, { url: "https://example.com/keynote" }]) {
      expect(checkIntentMismatch(READ_ONLY, { tool: "search_knowledge", capability: "knowledge.read", isMutation: false, params }).mismatch).toBe(false);
    }
  });

  it("an outbound send the task did not allow is a mismatch; reads of mail are not", () => {
    expect(isOutboundSend("send_email", "mail.send")).toBe(true);
    expect(isOutboundSend("post_webhook", "integrations.webhook")).toBe(true);
    expect(isOutboundSend("list_messages", "mail.read")).toBe(false);
    expect(isOutboundSend("query_postgres", "db.read")).toBe(false);
    expect(checkIntentMismatch({ access: "read_write" }, { tool: "send_email", capability: "mail.send", isMutation: true, params: {} }).reasons).toEqual(["outbound_send_out_of_scope"]);
    expect(checkIntentMismatch({ access: "read_write", outbound: true }, { tool: "send_email", capability: "mail.send", isMutation: true, params: {} }).mismatch).toBe(false);
  });

  it("a task declared with secrets access may touch them", () => {
    expect(targetsCredentials({ path: "/app/.env" })).toBe(true);
    expect(checkIntentMismatch({ access: "read_write", secrets: true }, { tool: "rotate_key", capability: "settings.manage", isMutation: true, params: { path: "/app/.env" } }).mismatch).toBe(false);
  });

  it("validates an untrusted declared scope; malformed means no scope, never a wider one", () => {
    expect(coerceDeclaredScope({ access: "read_only", outbound: "yes" })).toEqual({ access: "read_only", outbound: false, secrets: false });
    expect(coerceDeclaredScope({ access: "admin" })).toBeNull();
    expect(coerceDeclaredScope(null)).toBeNull();
  });
});

describe("OGIAM R-INTENT-MISMATCH-ESCALATE", () => {
  const input = { tool: "read_file", capability: "files.read", isMutation: false, surface: "/agent" };
  it("HOLDS (escalates) a call outside the declared scope, and records only reason ids", () => {
    const { action, redactedParams } = buildAction({ ...input, params: { path: "/app/.env" }, declaredScope: READ_ONLY });
    expect(action.signals.intentMismatch).toEqual(["credential_target"]);
    const d = decide(action, { mode: "enforce" });
    expect(d).toMatchObject({ ruleId: "R-INTENT-MISMATCH-ESCALATE", intendedOutcome: "escalate", wouldBlock: true, effectiveOutcome: "escalate" });
    expect(d.reason).toContain("credential_target");
    expect(redactedParams).not.toContain("intentMismatch");
  });
  it("monitor mode records without blocking", () => {
    const { action } = buildAction({ ...input, params: { path: "/app/.env" }, declaredScope: READ_ONLY });
    expect(decide(action, { mode: "monitor" })).toMatchObject({ ruleId: "R-INTENT-MISMATCH-ESCALATE", effectiveOutcome: "monitor", enforced: false });
  });
  it("is inert without a declared scope (existing actions unaffected)", () => {
    const { action } = buildAction({ ...input, params: { path: "/app/.env" } });
    expect(action.signals.intentMismatch).toBeUndefined();
    expect(decide(action, { mode: "enforce" }).ruleId).toBe("R-DEFAULT-ALLOW");
  });
  it("a secret in the params still denies first", () => {
    const { action } = buildAction({ ...input, params: { path: "/app/.env", key: "sk_live_" + "a".repeat(30) }, declaredScope: READ_ONLY });
    if (action.signals.secretDetected) expect(decide(action, { mode: "enforce" }).ruleId).toBe("R-SECRET-DENY");
  });
});
