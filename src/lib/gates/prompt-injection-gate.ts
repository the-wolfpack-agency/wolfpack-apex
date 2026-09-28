/**
 * prompt-injection gate - screen text bound for an AI agent for injection /
 * jailbreak attempts BEFORE it reaches the model. A client routing user input,
 * a document, or tool output into an agent can adopt this one gate to catch the
 * classic attacks (instruction override, role hijack, exfiltration prompts,
 * delimiter breakouts) deterministically - no model needed to decide.
 *
 *   no injection signal    -> allow
 *   injection detected      -> require_human (a person reviews before it reaches
 *                              the agent; the matched signals are reported)
 *
 * Precision-first: only high-signal phrases match, so ordinary prose passes.
 * Because a hit downgrades to require_human (never a hard deny), the occasional
 * false positive costs a human glance, never a blocked-by-mistake.
 */
import type { GateDefinition, GateResult } from "./types";

/** High-signal prompt-injection / jailbreak patterns. Kept specific to avoid
 *  flagging normal text; each is a phrase an attacker uses to override the agent. */
const INJECTION_PATTERNS: { id: string; re: RegExp }[] = [
  { id: "instruction-override", re: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:the\s+)?(?:previous|above|prior|earlier|system)\s+(?:instructions?|prompts?|rules?|context)/i },
  { id: "role-hijack", re: /\byou are now\b|\bact as (?:an?|the)\b.*\b(?:unrestricted|jailbroken|DAN|developer mode)\b|\bpretend (?:to be|you are)\b/i },
  { id: "system-prompt-exfil", re: /\b(?:reveal|show|print|repeat|leak|output)\s+(?:me\s+)?(?:your\s+)?(?:system\s+prompt|initial\s+instructions?|the\s+prompt above|your\s+instructions?)/i },
  { id: "guardrail-disable", re: /\b(?:disable|turn off|bypass|remove)\s+(?:your\s+)?(?:safety|guardrails?|content policy|filters?|restrictions?)/i },
  { id: "delimiter-breakout", re: /(?:```|"""|-{3,}|\]\]>|<\/(?:system|instructions?)>)\s*(?:system|assistant|ignore|new instructions)/i },
  { id: "data-exfil-instruction", re: /\b(?:send|post|exfiltrate|email|upload)\b.{0,40}\b(?:data|secrets?|keys?|credentials?|conversation)\b.{0,20}\bto\b/i },
];

export interface PromptInjectionInput {
  /** Text about to be routed into an AI agent (user input, a doc, tool output). */
  text: string;
}

export interface PromptInjectionOutput {
  matched: string[];
}

export const promptInjectionGate: GateDefinition<PromptInjectionInput, PromptInjectionOutput> = {
  name: "prompt-injection",
  entitlement: "secure_agent",
  purpose: "Screen text bound for an AI agent for injection / jailbreak attempts (instruction override, role hijack, prompt exfiltration, delimiter breakout) before it reaches the model - deterministically, no model needed.",
  async evaluate(input, ctx): Promise<GateResult<PromptInjectionOutput>> {
    const matched = INJECTION_PATTERNS.filter((p) => p.re.test(input.text)).map((p) => p.id);
    const base = {
      transparency: { checksRun: INJECTION_PATTERNS.map((p) => p.id), dataSeen: `The supplied text (${input.text.length} chars). No model invoked.`, modelInvoked: null, frameworksApplied: ctx.policy.frameworks },
    };

    if (matched.length === 0) {
      return {
        verdict: "allow",
        output: { matched: [] },
        findings: [],
        reason: "No prompt-injection signal detected; safe to route to the agent.",
        transparency: { ...base.transparency, explanation: "No injection signal." },
        audit: { gate: "prompt-injection", verdict: "allow", ruleId: "GATE-prompt-injection-clean", reason: "no injection signal", workspaceId: ctx.workspaceId, actorId: ctx.actorId },
      };
    }

    const reason = `Possible prompt-injection detected (${matched.join(", ")}). Stopping for a human before this text reaches the agent - review whether it is a legitimate request or an attempt to override the agent.`;
    return {
      verdict: "require_human",
      output: { matched },
      findings: matched.map((id) => ({ id, severity: "high" as const, detail: `injection signal: ${id}` })),
      reason,
      transparency: { ...base.transparency, explanation: reason },
      audit: { gate: "prompt-injection", verdict: "require_human", ruleId: "GATE-prompt-injection-detected", reason, workspaceId: ctx.workspaceId, actorId: ctx.actorId },
    };
  },
};
