/**
 * Edge-device exposure classifier.
 *
 * Given an ALREADY-COLLECTED HTTP response (status, headers, page title, body
 * excerpt), deterministically recognise the public login / VPN-portal page of a
 * common edge device (firewall / SSL-VPN appliance) and map the recognised
 * product to committed CISA KEV entries. PURE + OFFLINE: no network, no model,
 * same input -> same output. The findings model is the shared ScanFinding, so an
 * edge-exposure finding lands in the SAME store and review UI as every other
 * platform-scan finding (precision-first, see
 * [[platform-scan-precision-principle]]).
 *
 * This file does NOT decide whether it is allowed to run - gate.ts enforces the
 * off-by-default setting and the ownership floor BEFORE calling classifyEdgeDevice.
 */

import type { ScanFinding } from "../types";
import { EDGE_DEVICE_FINGERPRINTS } from "./fingerprints";
import { kevForProduct, KEV_SNAPSHOT_DATE, type KevEntry } from "./kev-snapshot";

/** An already-collected HTTP response - the pure input to classification. The
 *  collector (a gated, verified upstream probe) captures these fields; the
 *  classifier never fetches anything itself. */
export interface EdgeHttpResponse {
  /** Observed route/path or URL the response came from (used as the finding route). */
  route: string;
  /** HTTP status code, when known. */
  status?: number;
  /** Response headers with LOWER-CASED keys. Set-Cookie may be the combined value. */
  headers?: Record<string, string>;
  /** The page <title>, when extracted. */
  title?: string;
  /** A bounded excerpt of the response body (the collector caps the size). */
  bodyExcerpt?: string;
}

/** A positive recognition of one edge-device portal. */
export interface EdgeDeviceMatch {
  product: string;
  vendor: string;
  displayName: string;
  /** The specific markers that fired (for transparent, reviewable evidence). */
  matchedMarkers: string[];
}

/** Options for a classification. */
export interface EdgeClassifyOptions {
  /**
   * Whether the observed route counts as a marker. Default true (a response
   * observed AT an appliance path). The active scan pass sets it FALSE: it asks
   * for the appliance paths itself, so the path proves nothing about the host
   * and only the response body / vendor headers may decide. That is what keeps
   * a catch-all site that answers 200 for every path from reading as a VPN.
   */
  routeIsEvidence?: boolean;
}

/** The evidence.exposure_kind every edge-device finding carries, so the
 *  Forcefield Exposure panel can read exactly these rows from the shared store. */
export const EDGE_EXPOSURE_KIND = "edge_device";

/** Build the lower-cased searchable blob from body excerpt + observed route. The
 *  title is matched separately (corroboration only), never as a strong marker. */
function searchableBlob(res: EdgeHttpResponse, routeIsEvidence: boolean): string {
  return `${routeIsEvidence ? res.route ?? "" : ""}\n${res.bodyExcerpt ?? ""}`.toLowerCase();
}

/** Lower-cased header lookup; tolerant of callers that did not pre-lower keys. */
function headerValue(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return "";
  const direct = headers[name];
  if (direct !== undefined) return direct.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return (v ?? "").toLowerCase();
  }
  return "";
}

/**
 * Recognise the edge-device portal in a response, or null. Precision-first: a
 * match requires a STRONG body/URL marker OR a vendor header marker. A title
 * marker is only added as corroborating evidence once a strong marker already
 * fired - it can never, on its own, produce a match. The first fingerprint that
 * matches wins (markers are mutually exclusive by construction).
 */
export function classifyEdgeDevice(res: EdgeHttpResponse, opts: EdgeClassifyOptions = {}): EdgeDeviceMatch | null {
  const blob = searchableBlob(res, opts.routeIsEvidence !== false);
  const title = (res.title ?? "").toLowerCase();

  for (const fp of EDGE_DEVICE_FINGERPRINTS) {
    const matched: string[] = [];

    for (const marker of fp.strongMarkers) {
      if (blob.includes(marker)) matched.push(marker);
    }
    for (const hm of fp.headerMarkers ?? []) {
      if (headerValue(res.headers, hm.header).includes(hm.contains)) {
        matched.push(`${hm.header}:${hm.contains}`);
      }
    }

    // Precision gate: no strong body/header marker => not a match, whatever the
    // title says.
    if (matched.length === 0) continue;

    // Corroborating title evidence, recorded only (never decisive).
    for (const tm of fp.titleMarkers ?? []) {
      if (title.includes(tm)) matched.push(`title:${tm}`);
    }

    return {
      product: fp.product,
      vendor: fp.vendor,
      displayName: fp.displayName,
      matchedMarkers: matched,
    };
  }

  return null;
}

/** Highest-severity KEV drives the finding severity: any ransomware-linked KEV
 *  -> critical, otherwise high (a KEV is exploited-in-the-wild by definition, so
 *  an internet-facing portal exposing one is never below high). */
function severityFor(kev: KevEntry[]): ScanFinding["severity"] {
  return kev.some((k) => k.knownRansomware) ? "critical" : "high";
}

/**
 * Classify a response into zero or one ScanFinding. Returns [] when nothing is
 * recognised, or when a recognised product has no committed KEV entries (we do
 * NOT emit a bare "we saw a VPN portal" finding - the value is the KEV mapping,
 * and a no-KEV match would be noise).
 */
export function classifyEdgeExposure(res: EdgeHttpResponse, opts: EdgeClassifyOptions = {}): ScanFinding[] {
  const match = classifyEdgeDevice(res, opts);
  if (!match) return [];

  const kev = kevForProduct(match.product);
  if (kev.length === 0) return [];

  const cveIds = kev.map((k) => k.cveId);
  const ransomware = kev.some((k) => k.knownRansomware);
  const severity = severityFor(kev);

  return [
    {
      route: res.route,
      severity,
      category: "security",
      title: `Internet-facing ${match.displayName} with known-exploited CVEs`,
      detail:
        `The response matches a ${match.displayName}. This product family has ` +
        `${kev.length} entr${kev.length === 1 ? "y" : "ies"} on the CISA Known Exploited ` +
        `Vulnerabilities catalog (snapshot ${KEV_SNAPSHOT_DATE}): ${cveIds.join(", ")}. ` +
        `Confirm the appliance firmware is patched past each CVE and that management/portal ` +
        `access is restricted. This is outside-in exposure monitoring: it reports what the ` +
        `portal shows the internet and does not protect the appliance.` +
        (ransomware ? " At least one of these CVEs is linked to known ransomware campaigns." : ""),
      evidence: {
        exposure_kind: EDGE_EXPOSURE_KIND,
        product: match.product,
        vendor: match.vendor,
        matched_markers: match.matchedMarkers.join(", "),
        kev_count: kev.length,
        cve_ids: cveIds.join(", "),
        known_ransomware: ransomware,
        kev_snapshot_date: KEV_SNAPSHOT_DATE,
        status: res.status ?? null,
      },
    },
  ];
}
