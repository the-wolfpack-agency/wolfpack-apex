/**
 * Turn a data-flow map into a plan of attack.
 *
 * WHY THIS EXISTS. recommendAutomations reads a SystemProfile, which is built
 * from a repository: migrations for the entities, route files for the
 * surfaces, dependency manifests for the integrations. A client who granted us
 * access to their running systems has given us none of that, so profile is
 * null and the integration plays never fire. The engagement that needs
 * recommendations most gets the fewest.
 *
 * The data-flow map carries the same signal from the outside. Every
 * third-party origin a page contacts is a vendor that client uses, observed
 * rather than declared, and observed is the stronger evidence: a dependency in
 * a manifest may be dead code, while a script tag on a live page is something
 * their users load today.
 *
 * PRECISION-FIRST, matching the detector philosophy in this directory. The
 * host table is short and each entry is a domain that vendor actually serves
 * from. A guess that names the wrong vendor in a client report costs more
 * trust than a miss costs coverage, so unrecognised origins are counted and
 * never guessed at.
 */

import { INTEGRATION_PLAYS } from "./engine";
import type { AutomationRecommendation } from "./types";
import type { DataFlowMap } from "../mapping/data-flow";

/**
 * Hostname suffix to integration name.
 *
 * Suffix rather than exact, so js.stripe.com and api.stripe.com both resolve,
 * and anchored at a dot so "notstripe.com" cannot match "stripe.com".
 */
const VENDOR_HOSTS: ReadonlyArray<[suffix: string, integration: string]> = [
  ["stripe.com", "Stripe"],
  ["stripe.network", "Stripe"],
  ["twilio.com", "Twilio"],
  ["salesforce.com", "Salesforce"],
  ["force.com", "Salesforce"],
  ["hubspot.com", "HubSpot"],
  ["hs-scripts.com", "HubSpot"],
  ["hsforms.net", "HubSpot"],
  ["intuit.com", "QuickBooks"],
  ["quickbooks.com", "QuickBooks"],
  ["plaid.com", "Plaid"],
  ["sendgrid.net", "Email provider"],
  ["mailchimp.com", "Email provider"],
  ["mandrillapp.com", "Email provider"],
];

/** Which vendor an origin belongs to, or null when we do not recognise it. */
export function vendorForOrigin(origin: string): string | null {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const [suffix, integration] of VENDOR_HOSTS) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return integration;
  }
  return null;
}

/**
 * Recommendations a live system can support, without its source.
 *
 * Ordered by what an engineer would act on first: data leaving to a third
 * party, then the automations the observed vendors make possible.
 */
export function recommendFromDataFlows(map: DataFlowMap): AutomationRecommendation[] {
  const out: AutomationRecommendation[] = [];

  /* 1. THE ONE THAT COMES FIRST. A form posting off-site with a password or a
        card field in it is typed input going somewhere the client may not have
        decided to send it, and it is invisible to anyone reading the site
        rather than its markup. */
  const leaking = map.entryPoints.filter(
    (e) => e.crossOrigin && e.sensitiveFields.length > 0,
  );
  for (const form of leaking) {
    out.push({
      key: `security_remediation:cross_origin_form:${form.action}`,
      category: "security_remediation",
      priority: "critical",
      title: "A form sends sensitive fields to another company",
      rationale:
        "This form collects fields that look sensitive and submits them to an origin outside your own, so the data reaches a third party before it reaches you.",
      suggestedAction:
        "Confirm this vendor is meant to receive these fields and is covered by a processing agreement. If it is, document it. If it is not, post the form to your own origin and forward only what the vendor needs.",
      source: "data_flow:cross_origin_form",
      evidence: {
        page: form.page,
        action: form.action,
        fields: form.sensitiveFields.join(", "),
      },
    });
  }

  /* A cross-origin form WITHOUT sensitive fields is worth noting once rather
     than per form: it is a fact about the architecture, not an incident. */
  const plainCrossOrigin = map.entryPoints.filter(
    (e) => e.crossOrigin && e.sensitiveFields.length === 0,
  );
  if (plainCrossOrigin.length > 0) {
    out.push({
      key: "quality:cross_origin_forms",
      category: "quality",
      priority: "medium",
      title: `${plainCrossOrigin.length} form${plainCrossOrigin.length === 1 ? "" : "s"} submit to another company`,
      rationale:
        "Submissions leave your systems before you see them, so anything you want to measure, validate or retain has to be requested back from the vendor.",
      suggestedAction:
        "Decide which of these should post to your own origin first, so you hold the submission and forward it.",
      source: "data_flow:cross_origin_form",
      evidence: { count: plainCrossOrigin.length },
    });
  }

  /* 2. THE VENDORS THEY ALREADY USE. Observed on live pages rather than read
        from a manifest, which is the stronger evidence: a dependency may be
        dead code, a script tag is something their users load today. */
  const seen = new Set<string>();
  for (const exit of map.exitPoints) {
    const vendor = vendorForOrigin(exit.origin);
    if (!vendor || seen.has(vendor)) continue;
    const play = INTEGRATION_PLAYS[vendor];
    if (!play) continue;
    seen.add(vendor);

    out.push({
      key: `integration_automation:observed:${vendor}`,
      category: "integration_automation",
      priority: "medium",
      title: play.title,
      rationale: `${vendor} is contacted by pages on this site, so the integration already exists and can be automated rather than built.`,
      suggestedAction: play.action,
      source: `data_flow:vendor:${vendor}`,
      evidence: {
        vendor,
        origin: exit.origin,
        pages: exit.pages.length,
        seen_via: exit.via.join(", "),
      },
    });
  }

  /* 3. Unrecognised vendors are counted, never guessed at. Naming the wrong
        company in a client report costs more trust than a miss costs
        coverage. */
  const unknown = map.exitPoints.filter((e) => vendorForOrigin(e.origin) === null);
  if (unknown.length >= 5) {
    out.push({
      key: "operational:third_party_sprawl",
      category: "operational",
      priority: "low",
      title: `Pages contact ${unknown.length} third parties we could not identify`,
      rationale:
        "Each one is a company receiving something about your visitors. A list nobody maintains tends to grow, and every entry is a dependency and a disclosure.",
      suggestedAction:
        "Review the list and confirm each is still needed. Removing one is usually faster than justifying it later.",
      source: "data_flow:unrecognised_vendors",
      evidence: {
        count: unknown.length,
        origins: unknown.slice(0, 10).map((u) => u.origin).join(", "),
      },
    });
  }

  return out;
}
