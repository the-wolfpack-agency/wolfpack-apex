/**
 * Forcefield for the Web - the reusable, ruleset-driven observer.
 *
 * This is the ONE detection function every connected site runs. Given a request
 * and the current ruleset (fetched centrally, see ruleset.ts), it returns the
 * site-event to forward, or null for a normal visitor. It generalizes what used
 * to be Instinct-specific: the site passes its `surface` tag, everything else
 * comes from the shared ruleset, so adding a scanner signature or a trap path
 * happens ONCE (in the ruleset) and every site follows.
 *
 * PURE + EDGE-SAFE, MONITOR-ONLY: no I/O, produces an observation only, never a
 * block decision (props always record posture "monitor", blocked false).
 */
import { classifyWebRequest } from "./classify";
import { classifyClient, headerSignature, operatorFingerprint } from "./fingerprint";
import { classifyHosting, datacenterPrefixesFrom } from "./hosting";
import type { ForcefieldRuleset } from "./ruleset";

export type ForcefieldEventType =
  | "site.page_viewed"
  | "site.agent_welcomed"
  | "site.agent_flagged"
  | "site.agent_trap_tripped"
  | "site.agent_probed_sensitive";

export interface Observation {
  type: ForcefieldEventType;
  path: string;
  props: Record<string, string | number | boolean>;
}

export interface ObserveInput {
  /** The property/site this request hit (e.g. "instinct", "ogiam.com"). */
  site: string;
  path: string;
  method: string;
  userAgent: string;
  country: string;
  /** Lowercased list of the request's header names (for the header-order sig). */
  headerNames: readonly string[];
  /** The request's `Accept` header (used to tell a page navigation from an
   *  asset/XHR when `Sec-Fetch-Dest` is absent). Optional. */
  accept?: string;
  /** The request's `Sec-Fetch-Dest` header - "document" for a top-level page
   *  navigation. The strongest human-page-view signal (browser-only). Optional. */
  secFetchDest?: string;
  /** The client IP (from the edge). Classified to a hosting label and then
   *  DISCARDED - never stored. Optional; absent -> hosting "unknown". */
  ip?: string;
  nowMs: number;
}

/** A file-extension asset, an API call, or a Next internal - never a page view. */
function isNonPagePath(path: string): boolean {
  if (path === "/api" || path.startsWith("/api/")) return true;
  if (path.startsWith("/_next/")) return true;
  // A trailing file extension (.js, .css, .png, .ico, .map, .woff2, ...).
  return /\.[a-z0-9]{1,8}$/i.test(path);
}

/**
 * Is this a real human page view? A top-level HTML document navigation via GET.
 * `Sec-Fetch-Dest: document` is the definitive browser signal; when it is absent
 * we fall back to an `Accept: text/html` GET. Assets, API calls, XHR/fetch, and
 * non-GET methods are excluded, so this counts pages a person actually loaded -
 * the same thing ogiam.com's analytics counts, now for every monitored property.
 */
function isHumanPageView(input: ObserveInput): boolean {
  if (input.method.toUpperCase() !== "GET") return false;
  if (isNonPagePath(input.path)) return false;
  const dest = (input.secFetchDest ?? "").toLowerCase();
  if (dest) return dest === "document";
  return (input.accept ?? "").toLowerCase().includes("text/html");
}

/** A stable, non-PII session key: UA + country + hour bucket + header-order hash,
 *  so one actor's requests within an hour cluster, and header shape sharpens the
 *  resolution (survives UA spoofing). Edge-safe FNV-1a. */
function sessionSig(userAgent: string, country: string, headerNames: readonly string[], nowMs: number): string {
  const bucket = Math.floor(nowMs / 3_600_000);
  const s = `${userAgent}|${country}|${bucket}|${headerSignature(headerNames)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Does the path hit a sensitive/nonexistent recon path? Exact or one segment
 *  deeper (so "/wp-admin" and "/wp-admin/x" match, but "/.environment" does not
 *  match "/.env"). Returns the matched pattern, or null. */
function matchedSensitive(path: string, sensitivePaths: readonly string[]): string | null {
  for (const p of sensitivePaths) {
    if (path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`)) return p;
  }
  return null;
}

/**
 * Inspect one request against the current ruleset. Most-severe first: a decoy
 * trip, then a sensitive-path probe, then a welcomed known agent, then flagged
 * automation (self-declared bot, a named scanner/library/headless tool, or a
 * browser UA whose headers don't match). A normal visitor returns null - the
 * common path, so nothing is forwarded for real users.
 */
export function observeRequest(input: ObserveInput, ruleset: ForcefieldRuleset): Observation | null {
  const { path, method, userAgent } = input;
  const verdict = classifyWebRequest(
    { path, method, userAgent },
    { trapPaths: ruleset.trapPaths, knownAgents: ruleset.knownAgents },
  );
  const client = classifyClient(userAgent, input.headerNames, ruleset.toolSignatures);
  const probe = matchedSensitive(path, ruleset.sensitivePaths);

  let type: ForcefieldEventType | null = null;
  if (verdict.class === "trapped") type = "site.agent_trap_tripped";
  else if (probe) type = "site.agent_probed_sensitive";
  else if (verdict.class === "known_agent") type = "site.agent_welcomed";
  else if (
    verdict.class === "suspicious" ||
    client.clientType === "scanner" ||
    client.clientType === "scripted_library" ||
    client.clientType === "headless" ||
    client.headerMismatch
  ) {
    type = "site.agent_flagged";
  }

  // Not an agent. If it is a real human page navigation, forward it as a page
  // view so the property reports the SAME analytics as ogiam.com (page views,
  // hourly heatmap, top pages, top countries) - not just agent traffic. Anything
  // else (assets, XHR, non-GET) is a normal non-page request: forward nothing.
  if (!type) {
    if (isHumanPageView(input)) {
      return {
        type: "site.page_viewed",
        path,
        props: {
          site: input.site,
          sig: sessionSig(userAgent, input.country, input.headerNames, input.nowMs),
        },
      };
    }
    return null;
  }

  const props: Record<string, string | number | boolean> = {
    sig: sessionSig(userAgent, input.country, input.headerNames, input.nowMs),
    // A STABLE operator fingerprint (header-order shape bound to the client's
    // tool, NOT time-bucketed like sig). This is the key an admin "Block
    // operator" is enforced by at the edge: recomputable from any later request
    // by the same client + tool, so a blocked operator is turned away pre-
    // emptively, while a legit integration that only shares a header shape (but
    // runs a different tool) gets a different fp and is never caught.
    fp: operatorFingerprint(input.headerNames, client.tool, client.clientType),
    // Persisted as `site` (NOT `surface`): some properties already emit a
    // `props.surface` for the UI element an event came from (e.g. "dropdown",
    // "mobile"), so reusing it here would collide on the board's property filter.
    site: input.site,
    posture: "monitor",
    action: "report",
    blocked: false,
    agent: verdict.matchedAgentId ?? "unidentified",
    client_type: client.clientType,
    // Hosting: datacenter (cloud/hosting network) vs residential. A "browser"
    // from a datacenter is almost certainly automation - it CONFIRMS the client
    // class. Classified against the FULL prefix set the ruleset distributes (or
    // the bundled seed when absent); the IP is discarded, only this label stored.
    hosting: classifyHosting(input.ip, datacenterPrefixesFrom(ruleset.datacenterPrefixes)),
  };
  if (client.tool) props.tool = client.tool;
  if (probe) props.probe = probe;
  return { type, path, props };
}
