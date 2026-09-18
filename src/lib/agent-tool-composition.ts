/**
 * Agent tool-composition analysis - intent from the toolset, not the model.
 *
 * An agent's declared toolset is one of the most honest intent signals there is.
 * A model can be prompted to sound benign; a scaffolding that carries a
 * credential dictionary AND a login-attempt tool is doing credential stuffing no
 * matter what it says. The COMBINATION is the tell, and a novel/unique toolchain
 * is also a durable operator fingerprint (few operators build the same one).
 *
 * The honesty rail carries through: a dangerous tool being PRESENT is capability;
 * a malicious COMBINATION actually EXERCISED is intent. We label them differently
 * and never present "had the tool" as "used it maliciously".
 */

export type PolicyCategory =
  | "credential-abuse"
  | "data-exfil"
  | "evasion"
  | "unauthorized-access"
  | "abuse-at-scale";

export type ToolRisk = "benign" | "elevated" | "dangerous";

export interface AgentTool {
  id: string;
  label: string;
  risk: ToolRisk;
  /** Policy categories this tool implicates when it is USED (not merely present). */
  policies: PolicyCategory[];
}

/** The known-tool catalog. A used tool absent from here is NOVEL - itself a
 *  signal (an unrecognized capability, worth a closer look). */
export const TOOL_CATALOG: Readonly<Record<string, AgentTool>> = {
  fetch: { id: "fetch", label: "Fetch a URL", risk: "benign", policies: [] },
  read_robots: { id: "read_robots", label: "Read robots.txt", risk: "benign", policies: [] },
  read_sitemap: { id: "read_sitemap", label: "Read sitemap", risk: "benign", policies: [] },
  submit_form: { id: "submit_form", label: "Submit a form", risk: "elevated", policies: [] },
  download_file: { id: "download_file", label: "Download a file", risk: "elevated", policies: [] },
  scrape_bulk: { id: "scrape_bulk", label: "Bulk-harvest pages", risk: "elevated", policies: ["abuse-at-scale"] },
  auth_attempt: { id: "auth_attempt", label: "Attempt a login", risk: "dangerous", policies: ["credential-abuse", "unauthorized-access"] },
  credential_list: { id: "credential_list", label: "Credential dictionary", risk: "dangerous", policies: ["credential-abuse"] },
  exfiltrate: { id: "exfiltrate", label: "Send data to an external endpoint", risk: "dangerous", policies: ["data-exfil"] },
  captcha_solve: { id: "captcha_solve", label: "Solve a CAPTCHA", risk: "dangerous", policies: ["evasion"] },
  proxy_rotate: { id: "proxy_rotate", label: "Rotate source IPs", risk: "dangerous", policies: ["evasion"] },
  rate_bypass: { id: "rate_bypass", label: "Bypass rate limits", risk: "dangerous", policies: ["evasion", "abuse-at-scale"] },
  inject_payload: { id: "inject_payload", label: "Inject a crafted payload", risk: "dangerous", policies: ["unauthorized-access"] },
};

export interface MaliciousCombination {
  tools: readonly string[];
  intent: string;
  why: string;
}

/** Tool SETS that are hostile by composition: each is benign-ish in isolation but
 *  the combination has no legitimate purpose on someone else's surface. */
export const MALICIOUS_COMBINATIONS: readonly MaliciousCombination[] = [
  { tools: ["auth_attempt", "credential_list"], intent: "credential_stuffing", why: "testing a credential dictionary against a login" },
  { tools: ["scrape_bulk", "exfiltrate"], intent: "data_theft", why: "mass-harvesting content and shipping it out" },
  { tools: ["captcha_solve", "submit_form"], intent: "abuse_automation", why: "defeating anti-bot protection to submit at scale" },
  { tools: ["proxy_rotate", "rate_bypass"], intent: "detection_evasion", why: "spreading requests to dodge rate limits and blocking" },
  { tools: ["inject_payload", "auth_attempt"], intent: "intrusion_attempt", why: "probing for a way in and attempting access" },
  { tools: ["scrape_bulk", "proxy_rotate"], intent: "evasive_harvest", why: "mass-harvesting while rotating IPs to avoid being cut off" },
];

const RISK_ORDER: Record<ToolRisk, number> = { benign: 0, elevated: 1, dangerous: 2 };

export interface ToolCompositionReport {
  usedTools: string[];
  /** Used tools not in the catalog - an unrecognized capability. */
  novelTools: string[];
  /** Policy categories implicated by the used tools. */
  policies: PolicyCategory[];
  /** Malicious combinations actually EXERCISED (all their tools were used). */
  maliciousCombinations: MaliciousCombination[];
  riskTier: ToolRisk;
  /** The dominant intent, or "benign" / "elevated_capability". */
  intent: string;
  /** proven: a malicious combination was exercised (intent, not just capability).
   *  inferred: dangerous capability present but no exercised malicious combo. */
  confidence: "proven" | "inferred" | "none";
  summary: string;
}

/**
 * Analyze the tools an agent actually USED (the exercised toolset). Deterministic.
 * Distinguishes exercised malicious combinations (proven intent) from lone
 * dangerous capabilities (inferred), and flags novel tools.
 */
export function analyzeToolComposition(usedToolIds: readonly string[]): ToolCompositionReport {
  const used = Array.from(new Set(usedToolIds.filter(Boolean)));
  const usedSet = new Set(used);
  const novelTools = used.filter((id) => !(id in TOOL_CATALOG));

  const policies = Array.from(
    new Set(used.flatMap((id) => TOOL_CATALOG[id]?.policies ?? [])),
  );

  const maliciousCombinations = MALICIOUS_COMBINATIONS.filter((c) => c.tools.every((t) => usedSet.has(t)));

  // Risk tier: the highest risk among used tools; a novel tool is treated as at
  // least elevated (unknown capability), and any exercised malicious combo is
  // dangerous.
  let riskTier: ToolRisk = "benign";
  for (const id of used) {
    const r = TOOL_CATALOG[id]?.risk ?? "elevated"; // novel -> elevated
    if (RISK_ORDER[r] > RISK_ORDER[riskTier]) riskTier = r;
  }
  if (maliciousCombinations.length > 0) riskTier = "dangerous";

  const confidence: ToolCompositionReport["confidence"] =
    maliciousCombinations.length > 0 ? "proven" : riskTier === "dangerous" ? "inferred" : "none";

  const intent =
    maliciousCombinations[0]?.intent ??
    (riskTier === "dangerous" ? "elevated_capability" : riskTier === "elevated" ? "elevated_capability" : "benign");

  return {
    usedTools: used,
    novelTools,
    policies,
    maliciousCombinations,
    riskTier,
    intent,
    confidence,
    summary: summarize({ maliciousCombinations, novelTools, policies, riskTier, confidence }),
  };
}

function summarize(x: {
  maliciousCombinations: MaliciousCombination[];
  novelTools: string[];
  policies: PolicyCategory[];
  riskTier: ToolRisk;
  confidence: "proven" | "inferred" | "none";
}): string {
  if (x.maliciousCombinations.length > 0) {
    const c = x.maliciousCombinations[0];
    return `Malicious by composition: ${c.intent.replace(/_/g, " ")} (${c.why}). This is intent, not just capability - the combination was exercised.`;
  }
  if (x.novelTools.length > 0) {
    return `Carries an unrecognized tool (${x.novelTools.join(", ")}). Novel capability worth a closer look; not yet classifiable.`;
  }
  if (x.riskTier === "dangerous") {
    return `Dangerous capability present (${x.policies.join(", ") || "high-risk tool"}), but no malicious combination was exercised. Capability, not proven intent.`;
  }
  if (x.riskTier === "elevated") return "Elevated-capability toolset. Nothing hostile on its own.";
  return "Benign toolset.";
}
