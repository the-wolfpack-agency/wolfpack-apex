/**
 * Compliance findings for a client-facing site.
 *
 * Reads the shared network observations (../network/observations.ts) plus a few
 * page facts, and produces findings a client can be shown and a build can be
 * gated on.
 *
 * THE VERDICT VOCABULARY IS THE WHOLE DESIGN
 *
 * Three values, and the third is why this is trustworthy:
 *
 *   present      — we looked and it is there
 *   absent       — we looked and it is not
 *   unverifiable — we could not establish it either way
 *
 * "Unverifiable" is what keeps a one-click scan honest. A checker that only
 * says pass or fail has to guess when it cannot tell, and a guess presented as
 * a verdict is worse than no verdict at all — particularly on a report that
 * goes to a client.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not assess whether legal text is adequate. It can establish that a
 * privacy policy exists, is linked, and mentions the clauses a regulation names.
 * It cannot say those clauses are correct for this business, and a report that
 * implied otherwise would be a liability rather than a service. Every legal
 * finding is therefore about PRESENCE and REACHABILITY, never sufficiency, and
 * the wording says so.
 *
 * Pure: takes gathered facts, returns findings. Every rule is unit tested.
 */
import { firedBeforeConsent, outsideJurisdiction, thirdParties, type NetworkObservation, type ClassifiedRequest } from "../network/observations";

export type Verdict = "present" | "absent" | "unverifiable";
export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type FindingId =
  | "privacy-policy"
  | "terms"
  | "cookie-consent"
  | "tracking-before-consent"
  | "data-residency"
  | "accessibility-language"
  | "accessibility-title"
  | "contact-route"
  | "security-headers";

export interface ComplianceFinding {
  id: FindingId;
  /** Plain-language, client-readable. No jargon, no rule numbers. */
  title: string;
  verdict: Verdict;
  severity: Severity;
  /** What we saw. One or two sentences a non-specialist can act on. */
  detail: string;
  /** Present only when we can point at something concrete. */
  evidence?: Record<string, unknown>;
}

/** What the crawler managed to establish about the page itself. */
export interface PageFacts {
  /** Absolute URLs of every link found, for locating policy pages. */
  links: { href: string; text: string }[];
  /** <html lang="…">, or null when absent. */
  htmlLang: string | null;
  /** Document title, or null. */
  title: string | null;
  /** Response headers, lowercased keys. Empty when the fetch failed. */
  headers: Record<string, string>;
  /** True when the page's HTML could be read at all. Everything below is
   *  unverifiable when this is false — a page we could not load tells us
   *  nothing, and reporting "absent" for it would be a fabrication. */
  pageLoaded: boolean;
  /** Milliseconds at which a consent choice was recorded, null when no consent
   *  mechanism was detected. */
  consentAtMs: number | null;
  /** True when something consent-banner-shaped was found. Distinct from
   *  consentAtMs: a banner that exists but was never accepted is a different
   *  state from no banner at all. */
  consentMechanismFound: boolean;
}

export interface ComplianceInput {
  pageUrl: string;
  facts: PageFacts;
  observations: NetworkObservation[];
  /** ISO-3166 alpha-2 countries this client's data may be served from. Empty
   *  means no residency requirement was stated, and the check is skipped rather
   *  than assumed to be satisfied. */
  permittedCountries?: readonly string[];
}

/** Link text and hrefs that name a policy page, in the languages we serve. */
const POLICY_PATTERNS: Record<"privacy" | "terms", RegExp> = {
  privacy: /privacy|datenschutz|confidentialit|privacidad|informativa/i,
  terms: /terms|conditions|t&c|impressum|mentions.l|condiciones|termini/i,
};

function findPolicyLink(facts: PageFacts, kind: "privacy" | "terms"): { href: string; text: string } | null {
  const re = POLICY_PATTERNS[kind];
  return facts.links.find((l) => re.test(l.text) || re.test(l.href)) ?? null;
}

function policyFinding(facts: PageFacts, kind: "privacy" | "terms"): ComplianceFinding {
  const id: FindingId = kind === "privacy" ? "privacy-policy" : "terms";
  const label = kind === "privacy" ? "Privacy policy" : "Terms and conditions";

  if (!facts.pageLoaded) {
    return {
      id,
      title: `${label} could not be checked`,
      verdict: "unverifiable",
      severity: "medium",
      detail: "The page could not be loaded, so we could not look for this. This is not a statement that it is missing.",
    };
  }
  const link = findPolicyLink(facts, kind);
  if (!link) {
    return {
      id,
      title: `${label} is not linked from this page`,
      verdict: "absent",
      severity: kind === "privacy" ? "high" : "medium",
      detail: `No link to a ${label.toLowerCase()} was found. Visitors, and most regulations, expect one reachable from every page.`,
    };
  }
  return {
    id,
    title: `${label} is linked`,
    verdict: "present",
    severity: "info",
    // The sentence that keeps this honest. We checked reachability, not content.
    detail: `A ${label.toLowerCase()} link was found. This confirms it exists and is reachable; it is not a review of whether its wording is right for this business.`,
    evidence: { href: link.href, text: link.text },
  };
}

function consentFinding(facts: PageFacts): ComplianceFinding {
  if (!facts.pageLoaded) {
    return {
      id: "cookie-consent",
      title: "Consent mechanism could not be checked",
      verdict: "unverifiable",
      severity: "medium",
      detail: "The page could not be loaded, so we could not look for a consent banner.",
    };
  }
  if (!facts.consentMechanismFound) {
    return {
      id: "cookie-consent",
      title: "No consent mechanism found",
      verdict: "absent",
      severity: "high",
      detail:
        "Nothing that asks the visitor for consent was detected. Whether one is required depends on where the visitors are; where it is required, its absence means every tracker on the page runs without permission.",
    };
  }
  return {
    id: "cookie-consent",
    title: "Consent mechanism present",
    verdict: "present",
    severity: "info",
    detail: "Something that asks for consent was detected. Whether it blocks trackers until the visitor answers is reported separately below.",
  };
}

function trackingFinding(input: ComplianceInput): ComplianceFinding {
  const { facts, observations } = input;
  if (!facts.pageLoaded || observations.length === 0) {
    return {
      id: "tracking-before-consent",
      title: "Tracking behaviour could not be checked",
      verdict: "unverifiable",
      severity: "medium",
      detail:
        observations.length === 0
          ? "No network activity was captured, so we cannot say what this page contacts. An empty capture is not an empty page."
          : "The page could not be loaded.",
    };
  }
  const early = firedBeforeConsent(observations, facts.consentAtMs);
  if (early.length === 0) {
    return {
      id: "tracking-before-consent",
      title: "No tracking runs before consent",
      verdict: "present",
      severity: "info",
      detail: "Every third party this page contacts did so after the visitor had a chance to choose.",
    };
  }
  return {
    id: "tracking-before-consent",
    title: `${early.length} third part${early.length === 1 ? "y is" : "ies are"} contacted before consent`,
    verdict: "absent",
    severity: "critical",
    detail:
      `Data reaches ${early.map((c) => c.vendor ?? c.host).join(", ")} before the visitor agrees to anything` +
      (facts.consentMechanismFound ? "." : ", and no consent mechanism was found at all."),
    evidence: { hosts: early.map((c) => ({ host: c.host, vendor: c.vendor, kind: c.kind, atMs: c.atMs })) },
  };
}

function residencyFinding(input: ComplianceInput): ComplianceFinding {
  const permitted = input.permittedCountries ?? [];
  if (permitted.length === 0) {
    return {
      id: "data-residency",
      title: "No data-residency requirement was stated",
      verdict: "unverifiable",
      severity: "info",
      // Not "compliant". Nobody told us the rule, so we cannot say it is met.
      detail: "No permitted countries were configured for this client, so we could not check where their visitors' data is sent.",
    };
  }
  const { outside, unknown } = outsideJurisdiction(input.observations, permitted);
  if (outside.length === 0 && unknown.length === 0) {
    return {
      id: "data-residency",
      title: "All third parties are served from permitted countries",
      verdict: "present",
      severity: "info",
      detail: `Every third party resolved to one of: ${permitted.join(", ")}.`,
    };
  }
  if (outside.length > 0) {
    return {
      id: "data-residency",
      title: `${outside.length} third part${outside.length === 1 ? "y is" : "ies are"} served from outside the permitted countries`,
      verdict: "absent",
      severity: "high",
      detail: `Visitor data reaches ${outside.map((c) => `${c.host} (${c.serverCountry})`).join(", ")}, outside ${permitted.join(", ")}.`,
      evidence: { outside: outside.map((c) => ({ host: c.host, country: c.serverCountry })) },
    };
  }
  return {
    id: "data-residency",
    title: `${unknown.length} third part${unknown.length === 1 ? "y" : "ies"} could not be located`,
    verdict: "unverifiable",
    severity: "medium",
    detail: `We could not determine which country serves ${unknown.map((c) => c.host).join(", ")}. On a site with a residency obligation, an unlocated destination is a gap rather than a pass.`,
    evidence: { unknown: unknown.map((c) => c.host) },
  };
}

function languageFinding(facts: PageFacts): ComplianceFinding {
  if (!facts.pageLoaded) {
    return { id: "accessibility-language", title: "Page language could not be checked", verdict: "unverifiable", severity: "low", detail: "The page could not be loaded." };
  }
  if (!facts.htmlLang) {
    return {
      id: "accessibility-language",
      title: "Page does not declare its language",
      verdict: "absent",
      severity: "medium",
      detail: "Screen readers use the declared language to choose a voice and pronunciation. Without it they guess, and often guess wrong.",
    };
  }
  return { id: "accessibility-language", title: `Page declares its language as ${facts.htmlLang}`, verdict: "present", severity: "info", detail: "Assistive technology can select the right voice." };
}

function titleFinding(facts: PageFacts): ComplianceFinding {
  if (!facts.pageLoaded) {
    return { id: "accessibility-title", title: "Page title could not be checked", verdict: "unverifiable", severity: "low", detail: "The page could not be loaded." };
  }
  const t = (facts.title ?? "").trim();
  if (t === "") {
    return {
      id: "accessibility-title",
      title: "Page has no title",
      verdict: "absent",
      severity: "medium",
      detail: "The title is the first thing a screen reader announces and the label on a browser tab or bookmark.",
    };
  }
  return { id: "accessibility-title", title: "Page has a title", verdict: "present", severity: "info", detail: `Announced as "${t.slice(0, 80)}".` };
}

function securityHeaderFinding(facts: PageFacts): ComplianceFinding {
  if (!facts.pageLoaded || Object.keys(facts.headers).length === 0) {
    return {
      id: "security-headers",
      title: "Security headers could not be checked",
      verdict: "unverifiable",
      severity: "low",
      detail: "No response headers were captured, so we cannot say which protections are set.",
    };
  }
  const wanted = ["content-security-policy", "strict-transport-security", "x-content-type-options", "referrer-policy"];
  const missing = wanted.filter((h) => !facts.headers[h]);
  if (missing.length === 0) {
    return { id: "security-headers", title: "Core security headers are set", verdict: "present", severity: "info", detail: "The page sets the four headers that matter most for a public site." };
  }
  return {
    id: "security-headers",
    title: `${missing.length} security header${missing.length === 1 ? " is" : "s are"} missing`,
    verdict: "absent",
    severity: missing.includes("content-security-policy") ? "high" : "medium",
    detail: `Not set: ${missing.join(", ")}.`,
    evidence: { missing },
  };
}

function contactFinding(facts: PageFacts): ComplianceFinding {
  if (!facts.pageLoaded) {
    return { id: "contact-route", title: "Contact route could not be checked", verdict: "unverifiable", severity: "low", detail: "The page could not be loaded." };
  }
  const link = facts.links.find((l) => /contact|kontakt|contacto|mailto:/i.test(l.href) || /contact|kontakt|contacto/i.test(l.text));
  return link
    ? { id: "contact-route", title: "A way to make contact is linked", verdict: "present", severity: "info", detail: "Visitors have a route to reach the business.", evidence: { href: link.href } }
    : {
        id: "contact-route",
        title: "No contact route found",
        verdict: "absent",
        severity: "medium",
        detail: "No contact page or email link was found. Several jurisdictions require a reachable point of contact on a commercial site.",
      };
}

/** Run every check. Order is the order a client reads them: what is missing and
 *  serious first, then what is fine. */
export function runComplianceChecks(input: ComplianceInput): ComplianceFinding[] {
  const findings = [
    trackingFinding(input),
    policyFinding(input.facts, "privacy"),
    consentFinding(input.facts),
    residencyFinding(input),
    policyFinding(input.facts, "terms"),
    securityHeaderFinding(input.facts),
    languageFinding(input.facts),
    titleFinding(input.facts),
    contactFinding(input.facts),
  ];
  const rank: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export interface ComplianceSummary {
  total: number;
  present: number;
  absent: number;
  unverifiable: number;
  /** Highest severity among findings that are ABSENT. Unverifiable findings do
   *  not set this: not knowing is not the same as knowing it is wrong, and a
   *  report that conflates them cries wolf. */
  worstAbsent: Severity | null;
  /** One line for the top of a client report. */
  headline: string;
}

export function summarize(findings: ComplianceFinding[]): ComplianceSummary {
  const present = findings.filter((f) => f.verdict === "present").length;
  const absent = findings.filter((f) => f.verdict === "absent");
  const unverifiable = findings.filter((f) => f.verdict === "unverifiable").length;
  const rank: Severity[] = ["critical", "high", "medium", "low", "info"];
  const worstAbsent = rank.find((s) => absent.some((f) => f.severity === s)) ?? null;

  let headline: string;
  if (absent.length === 0 && unverifiable === 0) headline = `All ${findings.length} checks passed.`;
  else if (absent.length === 0) headline = `${present} checks passed; ${unverifiable} could not be established.`;
  else headline = `${absent.length} issue${absent.length === 1 ? "" : "s"} found, ${present} checks passed` + (unverifiable ? `, ${unverifiable} could not be established.` : ".");

  return { total: findings.length, present, absent: absent.length, unverifiable, worstAbsent, headline };
}

/** Every third party the page contacted, for the report's appendix. Exposed so
 *  a client can see the list rather than only the findings drawn from it. */
export function contactedThirdParties(observations: NetworkObservation[]): ClassifiedRequest[] {
  return thirdParties(observations);
}
