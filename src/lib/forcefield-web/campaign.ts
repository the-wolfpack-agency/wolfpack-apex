/**
 * Forcefield CAMPAIGN detection: the multi-step layer.
 *
 * decideEnforcement judges ONE request. A capable agent attacks the opposite way:
 * every single request looks benign, and the hostility lives in the SEQUENCE. It
 * recons the surface, chains a scraped id into an object it should not reach, walks
 * the id space, then exfiltrates. No single step trips a signature, so the
 * per-request gate is blind to it. This module holds the whole sequence for one
 * operator (keyed on the stable fingerprint observe.ts already stamps) and matches
 * kill-chain SHAPES deterministically.
 *
 * PURE + deterministic: same steps + options -> same verdict. No I/O, no model.
 * The caller supplies the recent step history for ONE operator (from recorded
 * events to "find it in the wild", or live once wired); this module only decides.
 * Conservative like the rest of Forcefield: a signature needs a real shape (breadth,
 * ordering, or enumeration), never a single ambiguous request, so normal browsing
 * never trips it.
 */
import { DEFAULT_RULESET, type ForcefieldRuleset } from "./ruleset";
import { detectPayload } from "./enforce";

/** Coarse, deterministic category for one step. The campaign shapes are expressed
 *  over these, not over raw paths, so the rules stay readable and testable.
 *  "payload" = the step itself carried an injection payload (SQLi/XSS/SSTI/...),
 *  which the per-request engine blocks alone; in a SEQUENCE it is the strongest
 *  combo signal. */
export type StepCategory = "payload" | "decoy" | "sensitive" | "auth" | "export" | "benign";

export interface OperatorStep {
  path: string;
  method: string;
  /** Epoch ms. Used only for windowing; relative order is what matters. */
  ts: number;
  /** The full target (path + query), so a payload in the query is seen. Falls
   *  back to `path` when absent. */
  rawUrl?: string;
}

export type CampaignSignatureId =
  | "recon_breadth"
  | "kill_chain"
  | "id_enumeration"
  | "payload_chain"
  | "auth_abuse"
  | "payload_fuzzing";

export interface CampaignSignature {
  id: CampaignSignatureId;
  severity: "high" | "medium";
  /** One plain sentence: what shape fired and why it is hostile. */
  reason: string;
  /** Indexes (into the input steps) that make the case, so it is auditable. */
  stepIndexes: number[];
}

export interface CampaignVerdict {
  /** True when at least one campaign signature fired. */
  campaign: boolean;
  signatures: CampaignSignature[];
  /** Worst severity across the fired signatures (absent when none). */
  severity?: "high" | "medium";
}

export interface CampaignOptions {
  ruleset?: ForcefieldRuleset;
  /** Only steps within this many ms of the latest step are considered (one burst). */
  windowMs?: number;
  /** Distinct sensitive/decoy paths that together count as surface recon. */
  reconBreadth?: number;
  /** Hits on one endpoint with distinct numeric ids that count as enumeration. */
  enumerationCount?: number;
  /** Auth-surface hits in the window that count as credential stuffing / brute force. */
  authAttempts?: number;
  /** Distinct injection-payload steps in the window that count as active fuzzing. */
  payloadBurst?: number;
}

const DEFAULTS = { windowMs: 120_000, reconBreadth: 4, enumerationCount: 5, authAttempts: 5, payloadBurst: 3 } as const;

// Deterministic surface map. Sensitive = recon/attack targets; export = bulk-data
// exfil; auth = credential surfaces. Kept tight (precision over recall) so benign
// traffic is never categorized hostile; the red-team's job is to find the shapes
// these miss, which then become new patterns here.
const SENSITIVE = [
  /\/admin(\/|$)/i, /\/wp-admin(\/|$)/i, /\/api\/(internal|admin|private)(\/|$)/i,
  /\/\.(env|git)(\/|$)/i, /\/config(\/|$|\.)/i, /\/actuator(\/|$)/i, /\/debug(\/|$)/i,
  /\/users?(\/|$)/i, /\/accounts?(\/|$)/i, /\/phpmyadmin(\/|$)/i, /\/\.well-known\/security/i,
];
const EXPORT = [
  /\/export(\/|$)/i, /\/download(\/|$)/i, /\/dump(\/|$)/i, /\/backup(\/|$)/i,
  /[?&]format=(csv|json|xlsx|sql)/i, /\/api\/[^?]*\/all(\/|$|\?)/i, /\/report(s)?\/.*\.(csv|xlsx)/i,
];
const AUTH = [/\/login(\/|$)/i, /\/signin(\/|$)/i, /\/oauth(\/|$)/i, /\/token(\/|$)/i, /\/session(\/|$)/i];

/** Categorize one step deterministically. `target` is the path or the full
 *  path+query (so a payload in the query is seen). Decoy (an invisible trap) and
 *  payload (a proven injection attempt, via the SAME detectPayload the per-request
 *  engine uses) are the strongest; then export, sensitive, auth; else benign. */
export function categorizeStep(target: string, ruleset: ForcefieldRuleset = DEFAULT_RULESET): StepCategory {
  const p = target || "";
  const pathOnly = p.split("?")[0];
  if (ruleset.trapPaths.some((t) => pathOnly === t || pathOnly.startsWith(t + "/"))) return "decoy";
  if (detectPayload(p)) return "payload";
  if (EXPORT.some((re) => re.test(p))) return "export";
  if (SENSITIVE.some((re) => re.test(p))) return "sensitive";
  if (AUTH.some((re) => re.test(p))) return "auth";
  return "benign";
}

/** The base of a path with a trailing/embedded numeric id removed, so /api/orders/41
 *  and /api/orders/42 share a base. Used to spot id-walking (IDOR sweeps). Returns
 *  null when there is no numeric id to vary. */
function enumerationKey(path: string): { base: string; id: string } | null {
  const noQuery = (path || "").split("?")[0];
  const m = noQuery.match(/^(.*?)(\d{1,})(\/?)$/);
  if (!m) {
    // Also catch a numeric id in the query (?id=42) on a stable path.
    const q = (path || "").match(/^([^?]*)\?.*\b(?:id|user|account|order|invoice)=(\d+)/i);
    return q ? { base: q[1] + "?id", id: q[2] } : null;
  }
  return { base: m[1] + "#" + m[3], id: m[2] };
}

/**
 * Decide whether a sequence of one operator's steps forms a hostile campaign.
 * Worst-first, deterministic, pure. Signatures:
 *   recon_breadth  - touched >= reconBreadth distinct sensitive/decoy paths in the
 *                    window (enumerating the attack surface).
 *   kill_chain     - a recon/sensitive/decoy touch FOLLOWED BY an export within the
 *                    window (recon then exfil, the classic agentic chain).
 *   id_enumeration - >= enumerationCount hits on one endpoint base with distinct
 *                    numeric ids (IDOR / object-id sweep).
 *   payload_chain  - an injection payload step COMBINED with recon of a sensitive/
 *                    decoy surface or an export, in one window (the multi-step combo).
 *   auth_abuse     - a burst of auth-surface hits (credential stuffing / brute force).
 *   payload_fuzzing- several DISTINCT injection payloads in one window (active vuln
 *                    scanning / fuzzing for one that lands).
 */
export function detectCampaign(steps: readonly OperatorStep[], opts: CampaignOptions = {}): CampaignVerdict {
  const ruleset = opts.ruleset ?? DEFAULT_RULESET;
  const windowMs = opts.windowMs ?? DEFAULTS.windowMs;
  const reconBreadth = opts.reconBreadth ?? DEFAULTS.reconBreadth;
  const enumerationCount = opts.enumerationCount ?? DEFAULTS.enumerationCount;
  const signatures: CampaignSignature[] = [];

  if (steps.length === 0) return { campaign: false, signatures: [] };

  // Keep only the latest burst (within windowMs of the newest step). Index map is
  // preserved so reported stepIndexes point back into the ORIGINAL input.
  const latest = Math.max(...steps.map((s) => s.ts));
  const idx = steps.map((_, i) => i).filter((i) => latest - steps[i].ts <= windowMs);
  const cat = idx.map((i) => ({ i, c: categorizeStep(steps[i].rawUrl ?? steps[i].path, ruleset), step: steps[i] }));

  // 1. recon breadth: distinct sensitive/decoy paths.
  const reconHits = cat.filter((x) => x.c === "sensitive" || x.c === "decoy");
  const distinctReconPaths = new Set(reconHits.map((x) => x.step.path));
  if (distinctReconPaths.size >= reconBreadth) {
    signatures.push({
      id: "recon_breadth",
      severity: "medium",
      reason: `enumerated ${distinctReconPaths.size} distinct sensitive paths in one window (surface recon)`,
      stepIndexes: reconHits.map((x) => x.i),
    });
  }

  // 2. kill chain: a recon/sensitive/decoy access BEFORE an export, in order.
  const firstReconPos = cat.findIndex((x) => x.c === "sensitive" || x.c === "decoy");
  const exportAfter = firstReconPos >= 0 ? cat.slice(firstReconPos + 1).find((x) => x.c === "export") : undefined;
  if (firstReconPos >= 0 && exportAfter) {
    signatures.push({
      id: "kill_chain",
      severity: "high",
      reason: "accessed a sensitive resource then hit a bulk-export path (recon then exfiltration)",
      stepIndexes: [cat[firstReconPos].i, exportAfter.i],
    });
  }

  // 3. id enumeration: one endpoint base, many distinct numeric ids.
  const byBase = new Map<string, { ids: Set<string>; idxs: number[] }>();
  for (const x of cat) {
    const k = enumerationKey(x.step.path);
    if (!k) continue;
    const e = byBase.get(k.base) ?? { ids: new Set<string>(), idxs: [] };
    e.ids.add(k.id);
    e.idxs.push(x.i);
    byBase.set(k.base, e);
  }
  for (const [, e] of byBase) {
    if (e.ids.size >= enumerationCount) {
      signatures.push({
        id: "id_enumeration",
        severity: "high",
        reason: `walked ${e.ids.size} distinct ids on one endpoint (object-id enumeration / IDOR sweep)`,
        stepIndexes: e.idxs,
      });
      break; // one enumeration signature is enough to make the case
    }
  }

  // 4. payload chain (the COMBO): the agent delivered an injection payload AND, in
  //    the same window, reconned a sensitive/decoy surface or hit an export. Each
  //    request alone is handled by the per-request engine; chained together they are
  //    a multi-step attack - probe the surface, then inject, or inject then exfil -
  //    the intricate shape a human takes much longer to assemble. The payload itself
  //    is proven-hostile, so pairing it with any recon/exfil step is high-confidence.
  const payloadSteps = cat.filter((x) => x.c === "payload");
  const chainPartners = cat.filter((x) => x.c === "sensitive" || x.c === "decoy" || x.c === "export");
  if (payloadSteps.length > 0 && chainPartners.length > 0) {
    const idxs = Array.from(new Set([...payloadSteps, ...chainPartners].map((x) => x.i))).sort((a, b) => a - b);
    signatures.push({
      id: "payload_chain",
      severity: "high",
      reason: `delivered an injection payload and ${chainPartners.some((x) => x.c === "export") ? "hit an export" : "reconned a sensitive surface"} in one session (multi-step attack chain)`,
      stepIndexes: idxs,
    });
  }

  // 5. auth abuse (credential stuffing / brute force): a burst of hits on the auth
  //    surface (login/signin/oauth/token/session) from one operator. A real user
  //    logs in once or twice; an agent stuffing credentials hammers it.
  const authHits = cat.filter((x) => x.c === "auth");
  if (authHits.length >= (opts.authAttempts ?? DEFAULTS.authAttempts)) {
    signatures.push({
      id: "auth_abuse",
      severity: "high",
      reason: `${authHits.length} auth-surface hits in one window (credential stuffing / brute force)`,
      stepIndexes: authHits.map((x) => x.i),
    });
  }

  // 6. payload fuzzing (active vuln scanning): several DISTINCT injection payloads in
  //    one window. Even without recon, an operator throwing many different payloads
  //    is fuzzing for one that lands - the automated scan a human never runs by hand.
  const distinctPayloads = new Set(payloadSteps.map((x) => x.step.rawUrl ?? x.step.path));
  if (distinctPayloads.size >= (opts.payloadBurst ?? DEFAULTS.payloadBurst)) {
    signatures.push({
      id: "payload_fuzzing",
      severity: "high",
      reason: `${distinctPayloads.size} distinct injection payloads in one window (active fuzzing / vuln scanning)`,
      stepIndexes: payloadSteps.map((x) => x.i),
    });
  }

  const severity = signatures.some((s) => s.severity === "high") ? "high" : signatures.length ? "medium" : undefined;
  return { campaign: signatures.length > 0, signatures, severity };
}
