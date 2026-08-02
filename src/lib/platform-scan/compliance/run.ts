/**
 * One click: authorize, look, judge, remember.
 *
 * Every piece of this already existed and none of it was reachable. findings.ts
 * could judge but nothing collected; collect.ts could collect but needed a
 * browser; the anomaly detector could compare but nothing produced a baseline.
 * This is the seam that turns them into a button, and it adds no new rules of
 * its own beyond the two below.
 *
 * IT ASKS THE GATE FIRST, EVERY TIME
 *
 * A compliance scan contacts a client's live system, so it goes through
 * authorizeBrowserAction as a read-only `navigate`. That is the same
 * defense-in-depth chain the browser driver uses — kill switch, ownership
 * floor, SSRF guard, OGIAM gate, hash-chained audit — and it is reused rather
 * than forked. A second, subtly different authorization path is how one of them
 * ends up weaker than the other.
 *
 * Note what this means: you cannot point this at an arbitrary URL. The target
 * must be curated or ownership-verified. That is the correct answer for a tool
 * that fetches a site and files a report about it.
 *
 * A TIER CANNOT REPORT WHAT IT CANNOT SEE
 *
 * The static tier reads served HTML. It cannot see a consent banner injected by
 * JavaScript, and it cannot see a tracker that another script loads later. Left
 * alone, findings.ts would read "no banner found" and report ABSENT — a
 * confident, wrong, client-facing claim, produced by a scan that simply was not
 * looking with the right instrument.
 *
 * downgradeForTier() converts exactly those verdicts to `unverifiable` with the
 * reason attached. Not knowing is not the same as knowing it is wrong, and the
 * whole value of this report is that it never confuses the two.
 */
import { runComplianceChecks, summarize, type ComplianceFinding, type ComplianceSummary, type PageFacts } from "./findings";
import { collectStatic, type StaticCollectDeps } from "./collect-static";
import { collectForCompliance, type CollectDeps } from "./collect";
import { buildDeclarations } from "../anomaly/declared";
import { detectAnomalies, type AnomalyReport } from "../anomaly/detect";
import { readBaseline, recordAnomalyRun } from "../anomaly/store";
import { authorizeBrowserAction, type BrowserGateDeps } from "../browser/gate";
import type { NetworkObservation } from "../network/observations";

export type ScanTier = "static" | "browser";

/**
 * Findings the static tier is not equipped to answer in the negative.
 *
 * `cookie-consent` — most consent platforms inject their banner with JavaScript,
 * so its absence from served HTML says nothing.
 * `tracking-before-consent` — depends on what actually fired, and the static
 * tier sees references rather than requests.
 *
 * A finding is only downgraded when it would otherwise read ABSENT. A PRESENT
 * verdict here is still safe: we found positive evidence, and finding it with a
 * weaker instrument does not make it less found.
 */
const NOT_ANSWERABLE_STATICALLY = new Set(["cookie-consent", "tracking-before-consent"]);

const STATIC_LIMIT_REASON =
  "This scan read the page as the server sent it. Consent banners and trackers are usually added by JavaScript afterwards, so this check needs a browser-backed scan to answer.";

export function downgradeForTier(findings: ComplianceFinding[], tier: ScanTier): ComplianceFinding[] {
  if (tier === "browser") return findings;
  return findings.map((f) =>
    f.verdict === "absent" && NOT_ANSWERABLE_STATICALLY.has(f.id)
      ? {
          ...f,
          verdict: "unverifiable" as const,
          title: f.title,
          detail: `${f.detail} ${STATIC_LIMIT_REASON}`,
          evidence: { ...(f.evidence ?? {}), downgradedFrom: "absent", tier },
        }
      : f,
  );
}

export interface SiteScanReport {
  pageUrl: string;
  /** The URL actually read, after redirects. Different from pageUrl means the
   *  site sent us somewhere else, and the report is about where we landed. */
  finalUrl: string;
  tier: ScanTier;
  findings: ComplianceFinding[];
  summary: ComplianceSummary;
  anomaly: AnomalyReport;
  /** Present when the page could not be read. Every check then reads
   *  unverifiable, which is the honest result rather than a clean bill. */
  error?: string;
  /** Set once persisted. Null when the scan was not stored. */
  runId: string | null;
  baselineUpdated: boolean;
}

export type RunSiteScanResult = { ok: true; report: SiteScanReport } | { ok: false; reason: string };

export interface RunSiteScanInput {
  workspaceId: string;
  /** Curated manifest key or onboarded target name. The ownership floor keys on
   *  this, not on the URL. */
  platform: string;
  pageUrl: string;
  actor: { userId: string; role: string };
  /** ISO-3166 alpha-2 codes this client's data may be served from. Empty means
   *  no residency requirement was stated, and the check is skipped rather than
   *  assumed satisfied. */
  permittedCountries?: readonly string[];
  /** Hosts an operator has already vouched for, from the target's record. */
  operatorAllowed?: readonly string[];
  /** Hosts implied by integrations the client is known to run. */
  integrationHosts?: readonly { host: string; name: string }[];
}

export interface RunSiteScanDeps {
  /** Supply a browser page to use the browser tier. Absent means static. */
  page?: CollectDeps["page"];
  gateDeps?: BrowserGateDeps;
  authorize?: typeof authorizeBrowserAction;
  staticDeps?: StaticCollectDeps;
  readBaseline?: typeof readBaseline;
  record?: typeof recordAnomalyRun;
  /** Set false to run without touching the database (a preview, or a caller
   *  that has not earned a write). Findings are returned either way. */
  persist?: boolean;
}

/**
 * Run one scan end to end.
 *
 * Returns `{ ok: false }` only when the gate refused. Everything else — a site
 * that is down, a page that will not parse, a database that will not accept the
 * run — still produces a report, because a report that says what it could not
 * establish is useful and a thrown error is not.
 */
export async function runSiteScan(input: RunSiteScanInput, deps: RunSiteScanDeps = {}): Promise<RunSiteScanResult> {
  const authorize = deps.authorize ?? authorizeBrowserAction;

  const auth = await authorize(
    {
      workspaceId: input.workspaceId,
      action: { kind: "navigate", targetUrl: input.pageUrl, platform: input.platform },
      actor: input.actor,
    },
    deps.gateDeps ?? {},
  );
  if (!auth.allowed) return { ok: false, reason: auth.reason };

  const tier: ScanTier = deps.page ? "browser" : "static";

  let facts: PageFacts;
  let observations: NetworkObservation[];
  let error: string | undefined;
  let finalUrl = input.pageUrl;

  if (deps.page) {
    const collected = await collectForCompliance(input.pageUrl, { page: deps.page });
    facts = collected.facts;
    observations = collected.observations;
    error = collected.error;
  } else {
    const collected = await collectStatic(input.pageUrl, deps.staticDeps);
    facts = collected.facts;
    observations = collected.observations;
    error = collected.error;
    finalUrl = collected.finalUrl;
  }

  const findings = downgradeForTier(
    runComplianceChecks({
      pageUrl: finalUrl,
      facts,
      observations,
      permittedCountries: input.permittedCountries,
    }),
    tier,
  );

  const declarations = buildDeclarations({
    pageUrl: finalUrl,
    headers: facts.headers,
    operatorAllowed: input.operatorAllowed,
    integrationHosts: input.integrationHosts,
  });

  // A baseline that cannot be read must not be mistaken for "never scanned":
  // that would make everything look non-novel forever, silently. Undefined from
  // a throw is indistinguishable from a genuine first scan, so a failure here
  // is surfaced as a caveat instead.
  let baseline: Awaited<ReturnType<typeof readBaseline>>;
  let baselineUnreadable = false;
  const read = deps.readBaseline ?? readBaseline;
  try {
    baseline = await read(input.workspaceId, input.platform);
  } catch {
    baseline = undefined;
    baselineUnreadable = true;
  }

  const anomaly = detectAnomalies({
    observations,
    declarations,
    baseline,
    consentAtMs: facts.consentAtMs,
    pageLoaded: facts.pageLoaded,
  });

  if (baselineUnreadable) {
    anomaly.caveats.push(
      "The record of previous scans could not be read, so nothing is reported as newly appeared. This is a system fault, not a finding about the site.",
    );
  }
  if (tier === "static") {
    anomaly.caveats.push(
      "This scan read the page as the server sent it rather than running it in a browser, so it sees the hosts the page references. A tracker added later by another script would not appear here.",
    );
  }

  let runId: string | null = null;
  let baselineUpdated = false;
  if (deps.persist !== false) {
    try {
      const recorded = await (deps.record ?? recordAnomalyRun)({
        workspaceId: input.workspaceId,
        targetId: input.platform,
        pageUrl: finalUrl,
        report: anomaly,
        observations,
        pageLoaded: facts.pageLoaded,
        actor: input.actor,
      });
      runId = recorded.runId;
      baselineUpdated = recorded.baselineUpdated;
    } catch {
      // A scan we could not store is still a scan the client can read. Losing
      // the findings because the write failed would be the worse outcome.
      anomaly.caveats.push("This run could not be saved, so it will not be used as a baseline for the next scan.");
    }
  }

  return {
    ok: true,
    report: {
      pageUrl: input.pageUrl,
      finalUrl,
      tier,
      findings,
      summary: summarize(findings),
      anomaly,
      error,
      runId,
      baselineUpdated,
    },
  };
}
