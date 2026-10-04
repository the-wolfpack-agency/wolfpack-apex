/**
 * Factory gate: catch a NEW protected API route the factory authored that ships
 * WITHOUT an authorization check - CWE-862.
 *
 * The repo's capability-coverage guardrail requires every protected route.ts to
 * call requireCapability(); the factory must enforce the SAME rule on its OWN
 * output, so a missing-auth route is HELD at the gate (needs_human) rather than
 * left for the consuming repo's CI to catch. Found by dogfooding: an adversarial
 * missing-auth route slipped the factory gate (the live E2E flagged it relied on
 * apex CI as the only net).
 *
 * Pure + deterministic. Precision-first: it only fires on a route under a KNOWN
 * protected module that has NO recognized auth entrypoint AND no explicit
 * `// PUBLIC` opt-out, so a legitimately-gated or deliberately-public route passes.
 */
import type { ScanFinding } from "@/lib/platform-scan/types";

/** Mirrors PROTECTED_MODULES in src/__tests__/capability-coverage.test.ts. */
export const PROTECTED_API_MODULES: readonly string[] = [
  "admin", "hr", "finance", "clients", "meetings", "docs", "journal", "tasks", "knowledge", "tools",
];

/** Any recognized server-side authorization entrypoint. One present => the route gates. */
const AUTH_CONTROL = /\b(?:requireCapability|requireEntitlement|requireSession|factoryServiceAuth|isAuthorizedBearer|requireAgentAuth)\s*\(/;
/** An explicit, auditable opt-out for a deliberately public route. */
const PUBLIC_MARKER = /\/\/\s*PUBLIC\b/;

/** A protected API route.ts the repo requires to gate (module under app/api/<m>/). */
export function isProtectedApiRoute(path: string): boolean {
  const p = (path || "").replace(/^[ab]\//, "").replace(/^\.?\/+/, "");
  const m = p.match(/app\/api\/([^/]+)\/(?:.*\/)?route\.ts$/);
  return !!m && PROTECTED_API_MODULES.includes(m[1]);
}

/** True when the route has an auth control or is explicitly marked public. */
export function hasAuthControl(content: string): boolean {
  return AUTH_CONTROL.test(content) || PUBLIC_MARKER.test(content);
}

/** One critical finding per protected route the factory authored that lacks auth. */
export function findMissingAuth(files: readonly { path: string; content: string }[]): ScanFinding[] {
  const out: ScanFinding[] = [];
  for (const f of files) {
    if (!isProtectedApiRoute(f.path)) continue;
    if (hasAuthControl(f.content ?? "")) continue;
    out.push({
      route: f.path,
      severity: "critical",
      category: "security",
      title: "Missing authorization on a protected API route (CWE-862)",
      detail:
        "A new route under a protected API module has no requireCapability()/entitlement check and is not marked // PUBLIC. Add an authorization control or, if the route is genuinely public, a `// PUBLIC` marker.",
      evidence: { path: f.path, rule: "missing-auth", cwe: "CWE-862" },
    });
  }
  return out;
}
