/**
 * Authoring rules the executor must satisfy up front - the rules our CI failures
 * keep teaching, stated once so the model authors correct instead of getting
 * corrected in CI.
 *
 * DRY, deliberately: this module does NOT re-implement any check. Each rule is
 * ENFORCED by an existing guardrail (named in `enforcedBy`, the single source of
 * truth). Re-implementing the checks here as diff heuristics would duplicate that
 * logic and drift from it. This is guidance for the author (a legitimate
 * re-statement, since the model has to be told), not a second gate. Enforcement
 * stays where it lives: the guardrail suite (run via verify in the workspace) and
 * CI. The catalog exists so the executor prompt is generated from one list, and
 * a new guardrail adds one line here so the model learns it.
 */

export interface AuthoringRule {
  id: string;
  /** The rule, phrased as the author should hear it. */
  rule: string;
  /** The guardrail that ENFORCES it. This module never re-checks; it points. */
  enforcedBy: string;
}

export const AUTHORING_RULES: readonly AuthoringRule[] = [
  {
    id: "route-auth",
    rule: "A new API route must guard access (requireCapability / requireAdmin / requireEntitlement), or carry a `// PUBLIC` marker if it is intentionally unauthenticated.",
    enforcedBy: "AgenticQA auth-bypass scan + the PUBLIC-marker convention",
  },
  {
    id: "route-audit",
    rule: "A new route with a mutation handler (POST/PUT/PATCH/DELETE) must call recordAudit, or be added to AUDIT_ALLOWLIST with a reason if it is read-only-by-effect.",
    enforcedBy: "src/lib/__tests__/audit-coverage.test.ts + src/__tests__/AUDIT_ALLOWLIST.ts",
  },
  {
    id: "no-user-controlled-guard",
    rule: "Do not gate a sensitive call (a model call, a write) on a request value inside the handler; move the branch into a helper so no user input decides whether the sensitive step runs.",
    enforcedBy: "CodeQL js/user-controlled-bypass",
  },
  {
    id: "secret-in-log",
    rule: "Never pass a secret, token, credential, or reset URL to console.* or logger.*.",
    enforcedBy: "src/__tests__/no-secret-in-logs.test.ts",
  },
  {
    id: "raw-api-fetch",
    rule: 'In a "use client" component, authenticated calls go through fetchWithRefresh, never raw fetch("/api/...").',
    enforcedBy: "src/__tests__/no-raw-api-fetch.test.ts",
  },
  {
    id: "inline-prompt",
    rule: "A system prompt (a string that opens by assigning the model a role) must be registered in src/lib/prompts, not inlined.",
    enforcedBy: "src/lib/prompts/__tests__/prompt-coverage.test.ts",
  },
  {
    id: "e2e-register",
    rule: "A new e2e spec must be referenced in .github/workflows/e2e-reality-check.yml; an unlisted spec never runs.",
    enforcedBy: "src/__tests__/reality-check-workflow.test.ts",
  },
  {
    id: "silent-catch",
    rule: "A catch block must report (log / trackEvent / rethrow / a degradation note) or be declared quiet with a `silent-ok: <reason>` marker; it may not swallow silently.",
    enforcedBy: "src/lib/ci/__tests__/silent-catch-ratchet.test.ts",
  },
  {
    id: "no-duplicate-export",
    rule: "Before adding an exported symbol, check it does not duplicate an existing one; reuse or extend rather than re-implement.",
    enforcedBy: "src/__tests__/no-new-duplicate-exports.test.ts",
  },
  {
    id: "em-dash",
    rule: "No em dash (U+2014) in published content (docs, wiki, release copy); use a hyphen.",
    enforcedBy: "src/__tests__/no-em-dashes.test.ts",
  },
  {
    id: "verify-before-pr",
    rule: "The full local guardrail suite must pass before the change is handed off; a PR should confirm CI, not discover failures.",
    enforcedBy: "scripts/verify.sh",
  },
];

/** The rules as a brief for the executor's system prompt, generated from the one
 *  catalog so a new guardrail is a one-line addition the model then learns. */
export function authoringConstraintsBrief(): string {
  return [
    "Repository rules you must satisfy up front (each is enforced by CI; satisfy it now, do not make CI discover it):",
    ...AUTHORING_RULES.map((r, i) => `${i + 1}. ${r.rule}`),
  ].join("\n");
}
