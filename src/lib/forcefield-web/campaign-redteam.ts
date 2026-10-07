/**
 * Campaign red-team: the multi-step analog of the single-request red-team. It
 * reuses BOTH halves we already built, DRY: `detectCampaign` (the deterministic
 * multi-step engine) decides, and `scoreGap` (the one gap scorer) measures. A
 * campaign is "blocked" when the detector flags it; so the same prevented/slipped
 * arithmetic that scores single requests scores campaigns, and the factory number
 * and the CI number stay the same measurement.
 *
 * A committed corpus of hostile campaigns (that the detector catches) and benign
 * multi-page sessions (that it must never flag) is the regression: a campaign
 * shape, once detected, stays detected; and hardening never starts flagging a real
 * user's normal session. The offline generator (scripts/forcefield-ai-redteam.ts)
 * produces NEW campaigns; a slip (a hostile campaign we do not yet detect) is the
 * next signature to add to campaign.ts.
 */
import { detectCampaign, type OperatorStep, type CampaignOptions } from "./campaign";
import { scoreGap, type GapOutcome, type GapScore } from "./gap-metric";

/** One generated/committed campaign: a step sequence for a single operator, plus
 *  whether it is a genuine attack (the detector SHOULD flag it). */
export interface CampaignCase {
  name: string;
  steps: Array<{ path: string; method?: string }>;
  intendedHostile: boolean;
}

/** Materialize a case into timed OperatorSteps (synthetic, evenly spaced so the
 *  whole sequence sits inside one window) and run the real detector. */
export function runCampaignCases(cases: readonly CampaignCase[], opts: CampaignOptions = {}): GapOutcome[] {
  return cases.map((c) => {
    const base = 1_000_000;
    const steps: OperatorStep[] = c.steps.map((s, i) => ({ path: s.path, method: s.method ?? "GET", ts: base + i * 1000 }));
    const verdict = detectCampaign(steps, opts);
    return { name: c.name, intendedHostile: c.intendedHostile, blocked: verdict.campaign };
  });
}

/** Score campaigns with the SAME scorer single requests use (DRY). */
export function scoreCampaignGap(cases: readonly CampaignCase[], opts: CampaignOptions = {}): GapScore {
  return scoreGap(runCampaignCases(cases, opts));
}

const seq = (name: string, paths: string[], intendedHostile: boolean): CampaignCase => ({
  name,
  steps: paths.map((p) => ({ path: p, method: "GET" })),
  intendedHostile,
});

export const AI_REDTEAM_CAMPAIGNS: readonly CampaignCase[] = [
  // Hostile campaigns the detector is confirmed to catch (regression targets).
  seq("surface recon sweep", ["/admin", "/wp-admin", "/.env", "/actuator", "/phpmyadmin"], true),
  seq("recon then exfiltration", ["/api/internal/customers", "/export/customers?format=csv"], true),
  seq("decoy trip then bulk download", ["/_ff/records", "/download/backup.sql"], true),
  seq("object-id enumeration (IDOR)", ["/api/invoices/100", "/api/invoices/101", "/api/invoices/102", "/api/invoices/103", "/api/invoices/104", "/api/invoices/105"], true),
  seq("sensitive config recon then export", ["/config.json", "/api/admin/settings", "/.git/config", "/debug/vars", "/export/config?format=json"], true),

  // Benign multi-page sessions a real user runs (must never be flagged).
  seq("normal product browsing", ["/", "/pricing", "/features", "/blog/launch", "/contact"], false),
  seq("a real login flow", ["/", "/login", "/account", "/account/settings"], false),
  seq("one admin viewing a couple of pages", ["/admin", "/admin/dashboard"], false),
  seq("reading docs that mention admin and export", ["/docs/admin-guide", "/docs/exporting-data"], false),
];
