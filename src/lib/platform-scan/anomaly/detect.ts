/**
 * Requests nothing in the system can account for.
 *
 * The claim this makes is narrow and deliberate: NOT "this is malicious", but
 * "this site contacted a host, and neither the site's own declarations nor any
 * previous scan explains why". That is a claim we can actually support, and it
 * is the more useful one — it produces the short list a person should look at,
 * instead of an accusation we would have to walk back.
 *
 * The two questions it answers:
 *
 *   1. UNEXPLAINED — nothing declares this host (declared.ts).
 *   2. NOVEL — this host was not here the last time we looked (the baseline).
 *
 * Both together is the signal that matters. A tracker that appeared between two
 * scans, that the site's own CSP does not permit, is the shape of a supply-chain
 * injection, a tag manager firing a vendor nobody approved, or marketing wiring
 * something up out-of-band. Each question alone is much weaker, and the report
 * says which one fired.
 *
 * THREE THINGS IT REFUSES TO DO
 *
 * It will not call anything novel without a baseline. On a first scan every host
 * is technically "new", and reporting that would bury the real signal under the
 * client's entire normal stack, exactly once, at the moment they are forming
 * their opinion of the tool. No baseline produces `novelty: "no-baseline"`.
 *
 * It will not report disappearances from an empty scan. If the page failed to
 * load, nothing was observed, and every previously-known host looks removed.
 * That reads as a dramatic change when it is actually a failed scan.
 *
 * It will not let the baseline launder a finding. A host stays unexplained for
 * as long as nothing explains it — being seen repeatedly only costs it its
 * novelty, never its finding. Otherwise scanning a site that was already
 * compromised would quietly bless the compromise on the second run.
 *
 * Pure. Every rule is unit tested without a network, a browser, or a database.
 */
import type { ScanSeverity } from "../types";
import { thirdParties, type ClassifiedRequest, type NetworkObservation, type TrackerKind } from "../network/observations";
import { explanationFor, type DeclarationSet, type DeclaredHost } from "./declared";

export type Novelty =
  /** Not in the baseline: first time we have seen this host on this target. */
  | "new"
  /** Present in the baseline. */
  | "known"
  /** No baseline exists, so the question cannot be answered yet. */
  | "no-baseline";

/** What a previous scan recorded, so "new" means something. */
export interface HostBaseline {
  host: string;
  /** ISO timestamp of first observation. */
  firstSeenAt: string;
  /** ISO timestamp of most recent observation. */
  lastSeenAt: string;
  /** How many scans have seen it. A host seen once may still be a blip. */
  scanCount: number;
}

export interface AnomalyFinding {
  host: string;
  severity: ScanSeverity;
  novelty: Novelty;
  /** The winning declaration, or null when nothing accounts for the host. */
  explainedBy: DeclaredHost | null;
  kind: TrackerKind;
  vendor: string | null;
  /** Plain sentence for the report. No jargon: clients read these. */
  summary: string;
  /** Raw signals, so a reviewer can check the verdict without re-running. */
  evidence: {
    firstContactMs: number;
    resourceType: string;
    status: number | null;
    withCredentials: boolean;
    /** True when it fired before any consent could have been given. */
    beforeConsent: boolean;
    scanCount: number | null;
  };
}

export interface AnomalyReport {
  findings: AnomalyFinding[];
  /** Hosts in the baseline that this scan did not see. Empty when the scan
   *  observed nothing at all, because that is a failed scan, not a change. */
  disappeared: string[];
  /**
   * Present when the report cannot be trusted as complete, with the reason in
   * plain words. The scan still returns a report; it just says what it could
   * not establish, in the same spirit as the compliance scan's "unverifiable".
   */
  caveats: string[];
  /** Counts for the summary line. */
  totals: { thirdParties: number; unexplained: number; novel: number };
}

export interface DetectInput {
  observations: NetworkObservation[];
  declarations: DeclarationSet;
  /** Prior scans for this target. Undefined and empty mean different things:
   *  undefined is "never scanned", empty is "scanned, saw no third parties". */
  baseline?: readonly HostBaseline[];
  /** When the visitor could first have consented. Null when no mechanism was
   *  found, which means nothing had consent, not that consent was unnecessary. */
  consentAtMs?: number | null;
  /** True when the page did not load. Suppresses disappearance reporting. */
  pageLoaded?: boolean;
}

/** Categories where an unexplained appearance is genuinely serious. A CDN we do
 *  not recognise is worth a look; an unrecognised session-replay vendor is
 *  recording the client's visitors. */
const SEVERE_KINDS: ReadonlySet<TrackerKind> = new Set<TrackerKind>(["session-replay", "advertising"]);

function severityFor(
  req: ClassifiedRequest,
  novelty: Novelty,
  explained: DeclaredHost | null,
  beforeConsent: boolean,
): ScanSeverity {
  if (explained) {
    // Declared, so not an anomaly. It can still be a consent problem, which is
    // findings.ts's job, so this stays low and does not double-report.
    return "low";
  }
  // Unexplained AND new is the shape of an injection.
  if (novelty === "new") {
    if (SEVERE_KINDS.has(req.kind) || req.withCredentials === true) return "critical";
    if (req.kind === "cdn") return "medium"; // a new script origin still matters
    return "high";
  }
  if (SEVERE_KINDS.has(req.kind)) return "high";
  if (beforeConsent && req.kind !== "cdn") return "medium";
  if (req.kind === "cdn") return "low";
  return "medium";
}

function summarize(req: ClassifiedRequest, novelty: Novelty, explained: DeclaredHost | null): string {
  const who = req.vendor ? `${req.vendor} (${req.host})` : req.host;
  if (explained) return `${who} was contacted, and is accounted for by ${explained.detail}.`;
  if (novelty === "new") {
    return `${who} was contacted for the first time, and nothing in the site's own declarations accounts for it.`;
  }
  if (novelty === "no-baseline") {
    return `${who} was contacted, and nothing in the site's own declarations accounts for it. This is the first scan of this site, so we cannot yet say whether it is new.`;
  }
  return `${who} was contacted, and nothing in the site's own declarations accounts for it. It was also present in previous scans.`;
}

export function detectAnomalies(input: DetectInput): AnomalyReport {
  const caveats: string[] = [];
  const contacted = thirdParties(input.observations);
  const hasBaseline = input.baseline !== undefined;
  const baseline = new Map((input.baseline ?? []).map((b) => [b.host, b]));

  if (!hasBaseline) {
    caveats.push(
      "No previous scan of this site exists, so nothing can be reported as newly appeared. The next scan will be able to.",
    );
  }
  if (input.declarations.noEvidence) {
    caveats.push(
      "This site publishes no Content-Security-Policy and has no recorded integrations, so there is nothing to check its outbound traffic against. Every third party below is listed as unexplained because we have no declaration to compare it to, not because it is necessarily wrong.",
    );
  }
  if (input.declarations.permissive.length > 0) {
    caveats.push(
      `This site's Content-Security-Policy permits any host (${input.declarations.permissive.join(", ")}), so it cannot be used to tell an intended request from an unintended one.`,
    );
  }
  if (input.pageLoaded === false) {
    caveats.push("The page did not load, so this scan observed little or nothing. Treat the result as incomplete.");
  }

  const consentCutoff = input.consentAtMs ?? Number.POSITIVE_INFINITY;
  const findings: AnomalyFinding[] = [];

  for (const req of contacted) {
    const explained = explanationFor(input.declarations, req.host);
    const prior = baseline.get(req.host);
    const novelty: Novelty = !hasBaseline ? "no-baseline" : prior ? "known" : "new";
    const beforeConsent = req.kind !== "cdn" && req.atMs < consentCutoff;

    // A declared, known, unremarkable host is not a finding. Reporting every
    // request the site legitimately makes is how a report becomes unread.
    if (explained && novelty !== "new") continue;

    findings.push({
      host: req.host,
      severity: severityFor(req, novelty, explained, beforeConsent),
      novelty,
      explainedBy: explained,
      kind: req.kind,
      vendor: req.vendor,
      summary: summarize(req, novelty, explained),
      evidence: {
        firstContactMs: req.atMs,
        resourceType: req.resourceType,
        status: req.status,
        withCredentials: req.withCredentials === true,
        beforeConsent,
        scanCount: prior?.scanCount ?? null,
      },
    });
  }

  const order: Record<ScanSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.host.localeCompare(b.host));

  // Nothing observed means nothing to compare. Every known host would look
  // removed, which is a failed scan wearing the costume of a big change.
  const observedAnything = contacted.length > 0;
  const disappeared =
    observedAnything && hasBaseline
      ? [...baseline.keys()].filter((h) => !contacted.some((c) => c.host === h)).sort()
      : [];
  if (!observedAnything && hasBaseline && baseline.size > 0) {
    caveats.push(
      "This scan saw no third-party requests at all while previous scans did. That usually means the scan failed rather than that the site changed, so no removals are reported.",
    );
  }

  return {
    findings,
    disappeared,
    caveats,
    totals: {
      thirdParties: contacted.length,
      unexplained: findings.filter((f) => !f.explainedBy).length,
      novel: findings.filter((f) => f.novelty === "new").length,
    },
  };
}

/**
 * Fold this scan's hosts into the baseline for the next one.
 *
 * Returns a NEW baseline rather than mutating, so a caller can decide whether to
 * persist it. That decision matters: a scan that failed must not be written
 * back, or one bad run erases the history that makes novelty detectable.
 * `shouldPersist` states the rule in one place instead of leaving it to each
 * caller to remember.
 */
export function foldBaseline(
  previous: readonly HostBaseline[] | undefined,
  observations: NetworkObservation[],
  nowIso: string,
): HostBaseline[] {
  const merged = new Map<string, HostBaseline>((previous ?? []).map((b) => [b.host, { ...b }]));
  for (const req of thirdParties(observations)) {
    const existing = merged.get(req.host);
    if (existing) {
      existing.lastSeenAt = nowIso;
      existing.scanCount += 1;
    } else {
      merged.set(req.host, { host: req.host, firstSeenAt: nowIso, lastSeenAt: nowIso, scanCount: 1 });
    }
  }
  return [...merged.values()].sort((a, b) => a.host.localeCompare(b.host));
}

/** Whether this scan is trustworthy enough to become the new baseline. */
export function shouldPersistBaseline(input: { pageLoaded?: boolean; observations: NetworkObservation[] }): boolean {
  if (input.pageLoaded === false) return false;
  return thirdParties(input.observations).length > 0 || input.observations.length > 0;
}
