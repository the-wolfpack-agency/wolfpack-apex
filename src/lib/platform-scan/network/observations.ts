/**
 * What a page actually contacted, and what that means.
 *
 * WHY ONE LAYER AND NOT THREE FEATURES
 *
 * A third-party request on a client's site is simultaneously three findings:
 *
 *   - a CONSENT finding, if it fires before the visitor agreed to anything
 *   - a DATA-SOVEREIGNTY finding, if an EU client's visitors are being sent to
 *     a host outside the EU
 *   - an UNEXPLAINED-SIGNAL finding, if nothing in the site's own code or
 *     dependencies accounts for it appearing
 *
 * Three detectors reading one set of observations gives cross-referenced
 * results for free: "a tracker appeared that no dependency change explains, it
 * fires before consent, and it resolves outside the client's jurisdiction" is a
 * single sentence only because the three questions share evidence. Building
 * them as three features would mean three crawls, three vocabularies, and no
 * way to say that sentence at all.
 *
 * The browser scan already watches in-page requests, but only records the ones
 * that failed (device-matrix.ts). This is the same observation widened: every
 * request, with what we can tell about it.
 *
 * Pure. The capture happens in the browser; this classifies what came back, so
 * every rule is unit tested without a network.
 */

/** One request the page made, as observed. */
export interface NetworkObservation {
  /** Absolute URL as requested. */
  url: string;
  /** Page URL that issued it, so first-party is decided against the right origin. */
  pageUrl: string;
  /** fetch/xhr/script/image/font/stylesheet/beacon/other, from the browser. */
  resourceType: string;
  /** Milliseconds after navigation start. Consent state is time-relative. */
  atMs: number;
  /** HTTP status, or null when the request never completed. */
  status: number | null;
  /** True when the request carried cookies. */
  withCredentials?: boolean;
  /** Resolved server country, when a geo lookup was possible. ISO-3166 alpha-2. */
  serverCountry?: string | null;
}

export type Party = "first-party" | "subdomain" | "third-party";

/** Categories that matter for a client-facing site. Deliberately small: a
 *  taxonomy nobody can hold in their head produces findings nobody acts on. */
export type TrackerKind = "analytics" | "advertising" | "social" | "tag-manager" | "session-replay" | "cdn" | "unknown";

/**
 * Hosts we can name. Precision-first, matching the platform-scan detector
 * philosophy: a short list of things we are SURE about beats a long list that
 * cries wolf. Anything unrecognised is "unknown", which is a prompt to look
 * rather than an accusation.
 */
const KNOWN_HOSTS: readonly { suffix: string; kind: TrackerKind; name: string }[] = [
  { suffix: "google-analytics.com", kind: "analytics", name: "Google Analytics" },
  { suffix: "analytics.google.com", kind: "analytics", name: "Google Analytics" },
  { suffix: "googletagmanager.com", kind: "tag-manager", name: "Google Tag Manager" },
  { suffix: "doubleclick.net", kind: "advertising", name: "Google Ads" },
  { suffix: "facebook.net", kind: "advertising", name: "Meta Pixel" },
  { suffix: "facebook.com", kind: "social", name: "Meta" },
  { suffix: "hotjar.com", kind: "session-replay", name: "Hotjar" },
  { suffix: "clarity.ms", kind: "session-replay", name: "Microsoft Clarity" },
  { suffix: "fullstory.com", kind: "session-replay", name: "FullStory" },
  { suffix: "segment.io", kind: "analytics", name: "Segment" },
  { suffix: "mixpanel.com", kind: "analytics", name: "Mixpanel" },
  { suffix: "plausible.io", kind: "analytics", name: "Plausible" },
  { suffix: "linkedin.com", kind: "social", name: "LinkedIn" },
  { suffix: "tiktok.com", kind: "social", name: "TikTok" },
  { suffix: "hubspot.com", kind: "analytics", name: "HubSpot" },
  { suffix: "intercom.io", kind: "analytics", name: "Intercom" },
  { suffix: "cloudflare.com", kind: "cdn", name: "Cloudflare" },
  { suffix: "jsdelivr.net", kind: "cdn", name: "jsDelivr" },
  { suffix: "unpkg.com", kind: "cdn", name: "unpkg" },
  { suffix: "gstatic.com", kind: "cdn", name: "Google static" },
  { suffix: "googleapis.com", kind: "cdn", name: "Google APIs" },

  /* ADDED FROM A REAL SCAN, 2026-08-30. Walking a client's forms platform
     found seven third-party hosts and could name two of them. The five it
     could not were reported as "unknown", which scores medium, so a product
     that records user sessions on a system holding client data read exactly
     like an unremarkable CDN.
     Named here because being unable to name a host is a prompt to look, and
     these have now been looked at. */
  { suffix: "pendo.io", kind: "session-replay", name: "Pendo" },
  /* Pendo and VWO are deliberately NOT the same kind, and the difference is
     not cosmetic: session-replay is in SEVERE_KINDS and analytics is not.
     Pendo's product includes session replay outright, so it earns the
     heavier classification. VWO is an experimentation platform that also
     offers recordings, and calling its base script session-replay would
     overstate what its presence proves. Overstating is how a report becomes
     one nobody reads. */
  { suffix: "visualwebsiteoptimizer.com", kind: "analytics", name: "Visual Website Optimizer" },
  /* The product's own object storage, not a third party in any meaningful
     sense, but it IS a different origin and pretending otherwise would be its
     own kind of dishonesty. Named so a reader can dismiss it quickly. */
  { suffix: "blob.core.windows.net", kind: "cdn", name: "Azure Blob Storage" },
];

/**
 * Hosts that need the PATH to identify, not just the name.
 *
 * google.com was contacted on all 38 screens of that scan and reported as an
 * unexplained third party. It is reCAPTCHA: a security control the site is
 * using to protect itself, which is close to the opposite of an unexplained
 * tracker. Matching on the host alone cannot tell the two apart, because
 * google.com serves both.
 *
 * Kept to signatures that cannot mean anything else, in the same spirit as the
 * detectors: a rule that guesses is worse than no rule.
 */
const KNOWN_PATHS: readonly { suffix: string; path: RegExp; kind: TrackerKind; name: string }[] = [
  { suffix: "google.com", path: /^\/recaptcha\//, kind: "cdn", name: "Google reCAPTCHA" },
  { suffix: "gstatic.com", path: /^\/recaptcha\//, kind: "cdn", name: "Google reCAPTCHA" },
];

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Registrable-ish root: last two labels. Good enough to tell a subdomain of
 *  the site from a genuinely different party, and honest about what it is —
 *  a full public-suffix list is the correct tool if this ever needs to be
 *  exact for a co.uk-style domain. */
export function rootDomain(host: string): string {
  const parts = host.split(".").filter(Boolean);
  return parts.length <= 2 ? host : parts.slice(-2).join(".");
}

/** Whose host is this, relative to the page that requested it? */
export function partyOf(url: string, pageUrl: string): Party {
  const h = hostOf(url);
  const p = hostOf(pageUrl);
  if (!h || !p) return "third-party";
  if (h === p) return "first-party";
  return rootDomain(h) === rootDomain(p) ? "subdomain" : "third-party";
}

/** Identify a host, or admit we cannot. */
export function identify(url: string): { kind: TrackerKind; name: string | null } {
  const h = hostOf(url);
  if (!h) return { kind: "unknown", name: null };

  /* Path rules first: they are strictly more specific, so a host that has one
     and matches it must not be caught by a broader entry for the same host. */
  const path = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return "";
    }
  })();
  for (const k of KNOWN_PATHS) {
    if ((h === k.suffix || h.endsWith(`.${k.suffix}`)) && k.path.test(path)) {
      return { kind: k.kind, name: k.name };
    }
  }

  for (const k of KNOWN_HOSTS) {
    // Dot-boundary match: "evil-hotjar.com" is not a subdomain of hotjar.com.
    if (h === k.suffix || h.endsWith(`.${k.suffix}`)) return { kind: k.kind, name: k.name };
  }
  return { kind: "unknown", name: null };
}

export interface ClassifiedRequest extends NetworkObservation {
  host: string;
  party: Party;
  kind: TrackerKind;
  /** Vendor name when recognised; null means unrecognised, not benign. */
  vendor: string | null;
}

export function classify(obs: NetworkObservation): ClassifiedRequest {
  const host = hostOf(obs.url) ?? "";
  const { kind, name } = identify(obs.url);
  return { ...obs, host, party: partyOf(obs.url, obs.pageUrl), kind, vendor: name };
}

/**
 * Every distinct third party a page contacted.
 *
 * Deduplicated by host, keeping the EARLIEST contact, because the question
 * downstream is "did this fire before consent" and the first occurrence is the
 * one that answers it.
 */
export function thirdParties(observations: NetworkObservation[]): ClassifiedRequest[] {
  const byHost = new Map<string, ClassifiedRequest>();
  for (const o of observations) {
    const c = classify(o);
    if (c.party !== "third-party" || c.host === "") continue;
    const existing = byHost.get(c.host);
    if (!existing || c.atMs < existing.atMs) byHost.set(c.host, c);
  }
  return [...byHost.values()].sort((a, b) => a.atMs - b.atMs);
}

/**
 * Requests that fired before the visitor could have consented.
 *
 * `consentAtMs` is null when no consent mechanism was detected at all, and that
 * is NOT the same as "no consent needed": with no banner, every tracker fired
 * without consent. Returning them is the honest answer, and the caller decides
 * whether the jurisdiction requires one.
 *
 * CDN and first-party requests are excluded. Loading a stylesheet is not
 * tracking, and a consent report that flags every font file trains people to
 * skim past it.
 */
export function firedBeforeConsent(observations: NetworkObservation[], consentAtMs: number | null): ClassifiedRequest[] {
  const cutoff = consentAtMs ?? Number.POSITIVE_INFINITY;
  return thirdParties(observations).filter((c) => c.kind !== "cdn" && c.atMs < cutoff);
}

/**
 * Third parties resolving outside a set of permitted countries.
 *
 * A host with no resolved country is returned as `unknown`, never quietly
 * dropped: "we could not tell where this goes" is a finding on a site with a
 * data-residency obligation, and dropping it would report compliance we did not
 * establish.
 */
export function outsideJurisdiction(
  observations: NetworkObservation[],
  permittedCountries: readonly string[],
): { outside: ClassifiedRequest[]; unknown: ClassifiedRequest[] } {
  const permitted = permittedCountries.map((c) => c.toUpperCase());
  const outside: ClassifiedRequest[] = [];
  const unknown: ClassifiedRequest[] = [];
  for (const c of thirdParties(observations)) {
    const country = c.serverCountry?.toUpperCase() ?? null;
    if (country == null) unknown.push(c);
    else if (!permitted.includes(country)) outside.push(c);
  }
  return { outside, unknown };
}

/**
 * Hosts that nothing in the site's own source accounts for.
 *
 * The anomaly half. `declaredHosts` is what the codebase can explain: hosts in
 * its dependencies, its configured integrations, its own domains. Anything
 * contacted but not declared is a signal to investigate — a tag manager firing
 * a vendor nobody added, a script injected by a compromised dependency, an
 * analytics beacon a marketing team wired up out-of-band.
 *
 * This does NOT assert wrongdoing. It asserts that the system cannot explain
 * the request, which is a different and more useful claim: it is exactly the
 * set a person should look at.
 */
export function unexplained(observations: NetworkObservation[], declaredHosts: readonly string[]): ClassifiedRequest[] {
  const declared = declaredHosts.map((h) => h.toLowerCase().replace(/^www\./, ""));
  const explains = (host: string) => declared.some((d) => host === d || host.endsWith(`.${d}`));
  return thirdParties(observations).filter((c) => !explains(c.host));
}
