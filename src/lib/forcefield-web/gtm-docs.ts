/**
 * Forcefield GTM / launch docs, surfaced IN THE APP (not repo-only markdown).
 *
 * The team works from the app, so these internal DRAFT docs (pricing, licensing,
 * SLA, security, subprocessors, and the legal templates) are readable at
 * /admin/forcefield/docs, admin-gated. This registry is the single source the
 * page + the API agree on, and it whitelists every key -> file, so a reader can
 * NEVER request an arbitrary path (no traversal): only a registered doc is read.
 *
 * The files live at docs/forcefield/*.md on disk and are read at request time
 * (same proven pattern as /api/security-posture). next.config pins them into the
 * function bundle via outputFileTracingIncludes.
 */
import { readFileSync } from "fs";
import { join } from "path";

export type GtmDocCategory = "Overview" | "Commercial" | "Legal (draft, needs counsel)";

export interface GtmDocMeta {
  key: string;
  title: string;
  category: GtmDocCategory;
  /** Path relative to docs/forcefield/. */
  file: string;
}

export const GTM_DOCS: readonly GtmDocMeta[] = [
  { key: "readme", title: "Overview + required-docs checklist", category: "Overview", file: "README.md" },
  { key: "brief", title: "Product brief + pitch (for the team + CEO)", category: "Overview", file: "product-brief.md" },
  { key: "network", title: "Network effect (how to explain + sell it)", category: "Overview", file: "network-effect.md" },
  { key: "launch", title: "Launch readiness + compliance scope (deterministic core)", category: "Overview", file: "launch-readiness.md" },
  { key: "rollout", title: "Rollout runbook: protect a site + join the network (shim)", category: "Overview", file: "rollout.md" },
  { key: "premortem", title: "Pre-mortem: failure scenarios + controls", category: "Overview", file: "pre-mortem.md" },
  { key: "pricing", title: "Pricing and packaging", category: "Commercial", file: "pricing-and-packaging.md" },
  { key: "licensing", title: "Licensing and subscription", category: "Commercial", file: "licensing.md" },
  { key: "sla", title: "SLA", category: "Commercial", file: "sla.md" },
  { key: "security", title: "Security and data handling", category: "Commercial", file: "security-and-data-handling.md" },
  { key: "subprocessors", title: "Subprocessors", category: "Commercial", file: "subprocessors.md" },
  { key: "tos", title: "Terms of Service", category: "Legal (draft, needs counsel)", file: "legal/terms-of-service.md" },
  { key: "privacy", title: "Privacy Policy", category: "Legal (draft, needs counsel)", file: "legal/privacy-policy.md" },
  { key: "dpa", title: "Data Processing Addendum", category: "Legal (draft, needs counsel)", file: "legal/dpa.md" },
  { key: "aup", title: "Acceptable Use Policy", category: "Legal (draft, needs counsel)", file: "legal/acceptable-use-policy.md" },
];

export function listGtmDocs(): GtmDocMeta[] {
  return GTM_DOCS.map((d) => ({ ...d }));
}

export function gtmDocByKey(key: string): GtmDocMeta | undefined {
  return GTM_DOCS.find((d) => d.key === key);
}

/** Read one registered doc's raw markdown. Returns null for an unknown key or a
 *  read failure (never throws, never reads outside the registry). */
export function readGtmDoc(key: string): string | null {
  const meta = gtmDocByKey(key);
  if (!meta) return null;
  try {
    return readFileSync(join(process.cwd(), "docs", "forcefield", meta.file), "utf-8");
  } catch {
    return null;
  }
}
