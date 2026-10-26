/**
 * Offline REPLAY of Forcefield intent scoring over recorded site events.
 *
 * Answers "would intent scoring have held this actor back earlier, and whom
 * would it have slowed by mistake?" from the events the engine already stored,
 * before any threshold is trusted in enforce mode. Pure: the caller loads the
 * rows (scripts/forcefield-intent-replay.ts, read-only) and this module runs the
 * SAME ledger + decision functions the edge runs (forcefield-web/intent.ts), so
 * the measured number and the shipped behavior cannot drift.
 *
 * Honest limits, carried into the report:
 *   - Only RECORDED requests replay. A normal non-page request (an asset, an XHR,
 *     a browser-UA request for a path that is not a page view) produced no event,
 *     so recon done that way is invisible here; the live engine sees it.
 *   - Query strings are not stored, so payload_shaped never fires in replay.
 *   - Sessions are keyed by the stored hourly sig (no IP is ever stored). Several
 *     visitors can share one sig, which can only INFLATE the false-positive count.
 *
 * Deterministic, no I/O, no model.
 */
import {
  IntentLedger,
  decideIntent,
  intentSignalsFor,
  resolveStackProfile,
  carriesOver,
  type CarryoverEntry,
  type IntentAction,
  type IntentProofKind,
  type IntentThresholds,
} from "@/lib/forcefield-web/intent";
import { DEFAULT_RULESET, type ForcefieldRuleset } from "@/lib/forcefield-web/ruleset";
import { FORCEFIELD_CONTROL_PLANE_PATHS } from "@/lib/forcefield-web/enforce";
import { isStaticAsset } from "@/lib/forcefield-web/observe";
import { classifyAutoBlockScope, splitFingerprint, type HeaderShapeSpread } from "@/lib/forcefield/autoblock-scope";

export interface ReplayEvent {
  ts: number;
  type: string;
  path: string;
  site: string;
  sig: string;
  fp?: string | null;
  clientType?: string | null;
  probe?: string | null;
  attack?: string | null;
  authenticated?: boolean;
  synthetic?: boolean;
  country?: string | null;
}

export interface ReplayOptions {
  /** Declared stack per site label (e.g. { instinct: ["nextjs"] }). A site
   *  without one replays with an unknown profile (recon signals off). */
  stacks: Readonly<Record<string, readonly string[]>>;
  ruleset?: ForcefieldRuleset;
  /** Carryover entry lifetime after the proof. */
  carryoverTtlMs?: number;
  /** Threshold override for tuning sweeps; defaults to INTENT_THRESHOLDS. */
  thresholds?: IntentThresholds;
}

const HOSTILE_TYPES = new Set(["site.agent_probed_sensitive", "site.agent_payload_attack", "site.agent_trap_tripped", "site.agent_form_honeypot", "site.agent_form_too_fast"]);

/** A clean proof: a decoy taken, a honeypot field, or a payload that is not the
 *  control-plane middleware-subrequest artefact (fixed in enforce.ts). Our own
 *  synthetic probes never count. */
export function proofOf(e: ReplayEvent): IntentProofKind | null {
  if (e.synthetic) return null;
  if (e.type === "site.agent_trap_tripped" || e.type === "site.agent_form_honeypot") return "decoy";
  if (e.type === "site.agent_payload_attack") {
    if (e.attack === "nextjs_middleware_bypass" && FORCEFIELD_CONTROL_PLANE_PATHS.has(e.path)) return null;
    return "payload";
  }
  return null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface ReplayReport {
  sessions: number;
  hostile: {
    sessions: number;
    /** Hostile sessions with at least one recorded request before the first proof. */
    withPrecursors: number;
    /** Later requests of a proven session (no proof of their own) that the
     *  sticky intent block would have turned away. Today each is let through
     *  unless it carries its own proof. */
    followOnRequestsBlocked: number;
    sessionsWithFollowOnBlocked: number;
    tarpittedBeforeProof: number;
    watchedBeforeProof: number;
    medianRequestsEarlier: number | null;
    medianSecondsEarlier: number | null;
  };
  neverHostile: {
    sessions: number;
    /** Sessions with recorded hostile tradecraft (a probe) but no proof. */
    reconOnly: number;
    reconOnlyTarpitted: number;
    /** No proof, no hostile event, AND independent evidence of a benign
     *  visitor: a human page view, a welcomed agent, or a site-attested
     *  authenticated request. A tarpit here is a false positive. */
    knownBenign: number;
    knownBenignTarpitted: number;
    knownBenignWatched: number;
    /** No proof, no hostile event, no benign evidence: anonymous automation the
     *  existing engine only labeled "flagged". Tarpits here need review; the
     *  reasons are in topReasons. */
    unlabeledAutomation: number;
    unlabeledAutomationTarpitted: number;
  };
  carryover: {
    entries: number;
    genericWithheld: number;
    sessionsCarried: number;
    carriedThenHostile: number;
    carriedKnownBenign: number;
  };
  /** Top foreign products / runtimes the tarpitted sessions asked for. */
  topReasons: Record<string, number>;
}

/** Header-shape spread from the replayed rows, for the autoblock-scope rule. */
function spreadByShape(events: readonly ReplayEvent[]): Map<string, HeaderShapeSpread> {
  const kinds = new Map<string, Set<string>>();
  const countries = new Map<string, Set<string>>();
  for (const e of events) {
    if (!e.fp) continue;
    const { shape, kind } = splitFingerprint(e.fp);
    (kinds.get(shape) ?? kinds.set(shape, new Set()).get(shape)!).add(kind);
    if (e.country) (countries.get(shape) ?? countries.set(shape, new Set()).get(shape)!).add(e.country);
  }
  const out = new Map<string, HeaderShapeSpread>();
  for (const [shape, k] of kinds) out.set(shape, { kinds: k.size, countries: countries.get(shape)?.size ?? 0 });
  return out;
}

/** Replay a time-ordered event stream. */
export function replayIntent(events: readonly ReplayEvent[], opts: ReplayOptions): ReplayReport {
  const ruleset = opts.ruleset ?? DEFAULT_RULESET;
  const ttl = opts.carryoverTtlMs ?? 7 * 86_400_000;
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const spread = spreadByShape(sorted);

  // Carryover list as the server would build it: first clean proof per fp,
  // distinctive fingerprints only, expiring ttl after the proof.
  const proofAt = new Map<string, number>();
  let genericWithheld = 0;
  const withheld = new Set<string>();
  for (const e of sorted) {
    if (!e.fp || proofAt.has(e.fp) || withheld.has(e.fp) || !proofOf(e)) continue;
    const scope = classifyAutoBlockScope(e.fp, spread.get(splitFingerprint(e.fp).shape) ?? null);
    if (scope.verdict === "distinctive") proofAt.set(e.fp, e.ts);
    else {
      withheld.add(e.fp);
      genericWithheld++;
    }
  }

  const bySession = new Map<string, ReplayEvent[]>();
  for (const e of sorted) {
    if (!e.sig) continue;
    const k = `${e.site}|${e.sig}`;
    (bySession.get(k) ?? bySession.set(k, []).get(k)!).push(e);
  }

  const ledger = new IntentLedger(1_000_000);
  const report: ReplayReport = {
    sessions: bySession.size,
    hostile: { sessions: 0, withPrecursors: 0, followOnRequestsBlocked: 0, sessionsWithFollowOnBlocked: 0, tarpittedBeforeProof: 0, watchedBeforeProof: 0, medianRequestsEarlier: null, medianSecondsEarlier: null },
    neverHostile: { sessions: 0, reconOnly: 0, reconOnlyTarpitted: 0, knownBenign: 0, knownBenignTarpitted: 0, knownBenignWatched: 0, unlabeledAutomation: 0, unlabeledAutomationTarpitted: 0 },
    carryover: { entries: proofAt.size, genericWithheld, sessionsCarried: 0, carriedThenHostile: 0, carriedKnownBenign: 0 },
    topReasons: {},
  };
  const earlierReq: number[] = [];
  const earlierSec: number[] = [];

  for (const [key, es] of bySession) {
    const profile = resolveStackProfile({ stack: opts.stacks[es[0].site] });
    const firstProof = es.findIndex((e) => proofOf(e) !== null);
    let firstWatch = -1;
    let firstTarpit = -1;
    let followOn = 0;
    let carried = false;
    let lastDetails: string[] = [];
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      const clientType = e.clientType ?? (e.type === "site.page_viewed" ? "browser" : "unknown");
      const entries: CarryoverEntry[] = [];
      if (e.fp && proofAt.has(e.fp) && proofAt.get(e.fp)! < e.ts && e.ts - proofAt.get(e.fp)! < ttl) {
        entries.push({ fp: e.fp, expiresAt: new Date(proofAt.get(e.fp)! + ttl).toISOString() });
      }
      const carry = carriesOver(e.fp ?? "", clientType, entries, e.ts);
      if (carry) carried = true;
      const signals = intentSignalsFor(
        {
          path: e.path,
          clientType,
          authenticated: e.authenticated === true || e.synthetic === true,
          welcomed: e.type === "site.agent_welcomed",
          probe: e.probe ?? null,
          staticAsset: isStaticAsset(e.path),
        },
        profile,
        ruleset,
      );
      const proof = proofOf(e) ?? undefined;
      const intent = ledger.note(key, e.ts, { path: e.path, signals, proof, nonBrowser: clientType !== "browser", carryover: carry });
      const d = decideIntent(intent, { posture: "enforce", keyScope: "client", clientType, thresholds: opts.thresholds });
      const rank: Record<IntentAction, number> = { none: 0, watch: 1, tarpit: 2, block: 3 };
      if (firstWatch < 0 && rank[d.action] >= 1) firstWatch = i;
      if (d.action === "block" && !proof) followOn++;
      if (firstTarpit < 0 && rank[d.action] >= 2) {
        firstTarpit = i;
        lastDetails = [...d.reasons, ...d.details];
      }
    }
    if (carried) report.carryover.sessionsCarried++;
    const hostileEvent = es.some((e) => HOSTILE_TYPES.has(e.type) && !e.synthetic);
    if (firstProof >= 0) {
      report.hostile.sessions++;
      if (carried) report.carryover.carriedThenHostile++;
      if (firstProof > 0) report.hostile.withPrecursors++;
      report.hostile.followOnRequestsBlocked += followOn;
      if (followOn > 0) report.hostile.sessionsWithFollowOnBlocked++;
      if (firstWatch >= 0 && firstWatch < firstProof) report.hostile.watchedBeforeProof++;
      if (firstTarpit >= 0 && firstTarpit < firstProof) {
        report.hostile.tarpittedBeforeProof++;
        earlierReq.push(firstProof - firstTarpit);
        earlierSec.push((es[firstProof].ts - es[firstTarpit].ts) / 1000);
        for (const r of lastDetails) report.topReasons[r] = (report.topReasons[r] ?? 0) + 1;
      }
    } else {
      report.neverHostile.sessions++;
      if (hostileEvent) {
        report.neverHostile.reconOnly++;
        if (firstTarpit >= 0) {
          report.neverHostile.reconOnlyTarpitted++;
          for (const r of lastDetails) report.topReasons[r] = (report.topReasons[r] ?? 0) + 1;
        }
      } else if (es.some((e) => e.type === "site.page_viewed" || e.type === "site.agent_welcomed" || e.authenticated || e.synthetic)) {
        report.neverHostile.knownBenign++;
        if (carried) report.carryover.carriedKnownBenign++;
        if (firstTarpit >= 0) report.neverHostile.knownBenignTarpitted++;
        else if (firstWatch >= 0) report.neverHostile.knownBenignWatched++;
      } else {
        report.neverHostile.unlabeledAutomation++;
        if (carried) report.carryover.carriedKnownBenign++;
        if (firstTarpit >= 0) {
          report.neverHostile.unlabeledAutomationTarpitted++;
          for (const r of lastDetails) report.topReasons[r] = (report.topReasons[r] ?? 0) + 1;
        }
      }
    }
  }
  report.hostile.medianRequestsEarlier = median(earlierReq);
  report.hostile.medianSecondsEarlier = median(earlierSec);
  return report;
}
