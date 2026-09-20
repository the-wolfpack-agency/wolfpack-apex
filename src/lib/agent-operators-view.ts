/**
 * Consolidate findings by OPERATOR: group the reconstructed journeys by their
 * durable operator fingerprint into one dossier per actor, so an analyst targets
 * a bad actor once instead of triaging its probes one by one.
 *
 * HONEST ABOUT THE FINGERPRINT. The operator key is a behavioral bucket, not an
 * identity: a coarse one (a single fetch probe, no robots, no link-following) is
 * shared by many unrelated actors, so grouping under it is "likely, not proven".
 * A distinctive fingerprint (link-following / retries / a richer toolset / a
 * repeated multi-finding pattern) is much stronger. Each group carries that
 * grouping confidence so the UI never overclaims that separate probes are one
 * actor. Pure + deterministic.
 */

import { severityOf, SEVERITY_ORDER, type Severity } from "@/lib/agent-triage";
import { matchProbePath, type ProbeCategory, type ProbeSeverity } from "@/lib/agent-probe-signatures";
import { stableHash } from "@/lib/agent-dossier";

/** The minimal shape a journey must expose to be consolidated. */
export interface OperatorViewJourney {
  key: string;
  behaviorClass: string;
  confidence: "proven" | "inferred";
  firstAt: string;
  lastAt: string;
  path: string[];
  eventCount: number;
  profile: {
    operatorKey: string;
    scaffolding: { pathDiscovery: string; readsRobotsFirst: boolean };
    toolComposition: { usedTools: string[] };
    insights: Array<{ kind: string; attack?: string }>;
  };
}

export type GroupingConfidence = "distinctive" | "coarse";

/** Worst-first rank so a category's severity is the worst path it contains. */
const PROBE_SEV_RANK: Record<ProbeSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

/** One attack category this operator targeted, with its worst severity + how
 *  many distinct paths in it. Drawn from the reused AgenticQA probe signatures. */
export interface TargetingCategory {
  category: ProbeCategory;
  severity: ProbeSeverity;
  count: number;
}

/** The richer, DESCRIPTIVE granularity for an operator (task A): what it targets
 *  (attack categories), what payloads it throws, and how fast it moves. Pure
 *  description layered on the existing coarse fingerprint - it changes nothing
 *  about grouping, so the blocklist + persisted history are untouched. */
export interface TargetingSignature {
  categories: TargetingCategory[];
  payloadTypes: string[];
  topSeverity: ProbeSeverity | "none";
  cadence: { findings: number; spanHours: number; perDay: number };
  summary: string;
}

/** A distinguishable targeting profile WITHIN one coarse operator bucket (task
 *  B): finer identity without changing the durable operator key. The coarse
 *  `operatorKey` stays the anchor for the blocklist and cross-day history; a
 *  `fingerprint` of `<operatorKey>.<hash>` subdivides the bucket only when the
 *  targeting signal actually differs, so a thin single-fetch bucket does not
 *  fragment. More than one sub-actor means "this fingerprint covers several
 *  distinguishable targeting profiles" - never a claim of separate real people. */
export interface SubActor<T extends OperatorViewJourney> {
  fingerprint: string;
  findingCount: number;
  categories: ProbeCategory[];
  payloadTypes: string[];
  pathDiscovery: string;
  journeys: T[];
}

/** Categories a single set of paths targets, worst-severity-first. */
function categoriesOf(paths: readonly string[]): TargetingCategory[] {
  const byCat = new Map<ProbeCategory, TargetingCategory>();
  for (const p of paths) {
    const sig = matchProbePath(p);
    if (!sig) continue;
    const cur = byCat.get(sig.category);
    if (cur) {
      cur.count += 1;
      if (PROBE_SEV_RANK[sig.severity] > PROBE_SEV_RANK[cur.severity]) cur.severity = sig.severity;
    } else {
      byCat.set(sig.category, { category: sig.category, severity: sig.severity, count: 1 });
    }
  }
  return Array.from(byCat.values()).sort(
    (a, b) => PROBE_SEV_RANK[b.severity] - PROBE_SEV_RANK[a.severity] || b.count - a.count || a.category.localeCompare(b.category),
  );
}

/** Build the descriptive targeting signature (A) for one operator group. */
function deriveTargeting(
  paths: readonly string[],
  payloadTypes: readonly string[],
  firstSeen: string,
  lastSeen: string,
  findingCount: number,
): TargetingSignature {
  const categories = categoriesOf(paths);
  const topSeverity: ProbeSeverity | "none" = categories[0]?.severity ?? "none";
  const first = Date.parse(firstSeen);
  const last = Date.parse(lastSeen);
  const spanHours =
    Number.isFinite(first) && Number.isFinite(last) && last > first
      ? Math.round(((last - first) / 3_600_000) * 10) / 10
      : 0;
  // Under a day of span reads as a single-day burst; otherwise normalize to /day.
  const perDay =
    spanHours >= 24 ? Math.round((findingCount / (spanHours / 24)) * 10) / 10 : findingCount;
  const parts: string[] = [];
  if (categories.length) parts.push(`targets ${categories.map((c) => `${c.category} (${c.count})`).join(", ")}`);
  if (payloadTypes.length) parts.push(`throws ${payloadTypes.join(", ")}`);
  parts.push(
    spanHours >= 24
      ? `${findingCount} finding${findingCount === 1 ? "" : "s"} over ${Math.round(spanHours / 24)}d (~${perDay}/day)`
      : `${findingCount} finding${findingCount === 1 ? "" : "s"} within a day`,
  );
  return { categories, payloadTypes: [...payloadTypes], topSeverity, cadence: { findings: findingCount, spanHours, perDay }, summary: parts.join(" · ") };
}

/** Cluster one coarse group's journeys into distinguishable targeting profiles
 *  (B). The sub-key folds in what the durable key deliberately omits - the
 *  target categories, payload types, and path-discovery strategy - so two
 *  different actors sharing a coarse bucket separate, WITHOUT changing the
 *  coarse key. */
function subActorsOf<T extends OperatorViewJourney>(operatorKey: string, journeys: readonly T[]): SubActor<T>[] {
  const byFp = new Map<string, SubActor<T>>();
  for (const j of journeys) {
    const cats = Array.from(new Set(categoriesOf(j.path).map((c) => c.category))).sort();
    const payloads = Array.from(
      new Set(j.profile.insights.filter((i) => i.kind === "payload_attack" && i.attack).map((i) => i.attack as string)),
    ).sort();
    const pd = j.profile.scaffolding.pathDiscovery;
    const tools = [...j.profile.toolComposition.usedTools].sort().join(",");
    const input = `${operatorKey}|cat:${cats.join("+")}|pl:${payloads.join("+")}|pd:${pd}|tools:${tools}`;
    const fingerprint = `${operatorKey}.${stableHash(input)}`;
    const cur = byFp.get(fingerprint);
    if (cur) {
      cur.findingCount += 1;
      cur.journeys.push(j);
      for (const c of cats) if (!cur.categories.includes(c)) cur.categories.push(c);
      for (const p of payloads) if (!cur.payloadTypes.includes(p)) cur.payloadTypes.push(p);
    } else {
      byFp.set(fingerprint, { fingerprint, findingCount: 1, categories: [...cats], payloadTypes: [...payloads], pathDiscovery: pd, journeys: [j] });
    }
  }
  return Array.from(byFp.values()).sort((a, b) => b.findingCount - a.findingCount || a.fingerprint.localeCompare(b.fingerprint));
}

export interface OperatorGroup<T extends OperatorViewJourney> {
  operatorKey: string;
  severity: Severity;
  /** Distinct behavior classes seen for this operator. */
  behaviorClasses: string[];
  findingCount: number;
  /** Union of the notable paths this operator touched across its findings. */
  paths: string[];
  /** Union of the named attack kinds (from payload-attack insights). */
  attacks: string[];
  firstSeen: string;
  lastSeen: string;
  proven: boolean;
  grouping: GroupingConfidence;
  groupingReason: string;
  /** Descriptive granularity (A): categories targeted, payloads, cadence. */
  targeting: TargetingSignature;
  /** Distinguishable targeting profiles inside this coarse bucket (B). */
  subActors: SubActor<T>[];
  journeys: T[];
}

/** A journey is "distinctive" if its scaffolding/tooling carries a discriminating
 *  feature; a bare single fetch probe is the coarse bucket everyone shares. */
function isDistinctiveJourney(j: OperatorViewJourney): boolean {
  const s = j.profile.scaffolding;
  return (
    s.pathDiscovery !== "none" ||
    s.readsRobotsFirst ||
    j.profile.toolComposition.usedTools.length > 1 ||
    j.eventCount > 1
  );
}

export function consolidateByOperator<T extends OperatorViewJourney>(journeys: readonly T[]): OperatorGroup<T>[] {
  const byOp = new Map<string, T[]>();
  for (const j of journeys) {
    const k = j.profile.operatorKey;
    const arr = byOp.get(k);
    if (arr) arr.push(j);
    else byOp.set(k, [j]);
  }

  const groups: OperatorGroup<T>[] = [];
  for (const [operatorKey, js] of byOp) {
    const severity = js
      .map(severityOf)
      .reduce((worst, s) => (SEVERITY_ORDER[s] < SEVERITY_ORDER[worst] ? s : worst), "benign" as Severity);
    const behaviorClasses = Array.from(new Set(js.map((j) => j.behaviorClass)));
    const paths = Array.from(new Set(js.flatMap((j) => j.path))).filter(Boolean);
    const attacks = Array.from(
      new Set(js.flatMap((j) => j.profile.insights.filter((i) => i.kind === "payload_attack" && i.attack).map((i) => i.attack as string))),
    );
    const firstSeen = js.map((j) => j.firstAt).filter(Boolean).sort()[0] ?? "";
    const lastSeen = js.map((j) => j.lastAt).filter(Boolean).sort().slice(-1)[0] ?? "";
    const proven = js.some((j) => j.confidence === "proven");

    // Grouping confidence: distinctive if any finding is distinctive, or if the
    // operator recurs across several findings (a repeated pattern is itself a
    // signal). Otherwise the coarse single-probe bucket.
    const distinctive = js.some(isDistinctiveJourney) || js.length >= 3;
    const grouping: GroupingConfidence = distinctive ? "distinctive" : "coarse";
    const groupingReason = distinctive
      ? js.length >= 3 && !js.some(isDistinctiveJourney)
        ? `Recurs across ${js.length} findings with the same fingerprint - a repeated pattern, stronger than a single coarse hit.`
        : "A discriminating fingerprint (link-following / retries / richer toolset / multi-request), so this grouping is comparatively strong."
      : "A coarse fingerprint (a single fetch probe, no robots, no link-following) that unrelated actors also share, so this grouping is likely, not proven.";

    const targeting = deriveTargeting(paths, attacks, firstSeen, lastSeen, js.length);
    const subActors = subActorsOf(operatorKey, js);

    groups.push({
      operatorKey, severity, behaviorClasses, findingCount: js.length, paths, attacks,
      firstSeen, lastSeen, proven, grouping, groupingReason, targeting, subActors, journeys: js,
    });
  }

  // Worst severity first; within, proven before inferred, then most recent.
  return groups.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      Number(b.proven) - Number(a.proven) ||
      b.lastSeen.localeCompare(a.lastSeen),
  );
}

// ── Codified operator insight ───────────────────────────────────────────────
// A deterministic, zero-token synthesis of an operator group into a decision-
// ready brief: verdict, what it targets, the key tells, and a recommended
// action. The data is already structured, so a codified summary beats an LLM on
// every axis that matters here (free, instant, auditable, reproducible, cannot
// hallucinate) - and OGIAM's posture is that a security VERDICT is deterministic,
// models only advise. Pure; the UI renders it at the top of the operator card.

export type RecommendedAction = "block" | "escalate" | "watch" | "acknowledge";

export interface OperatorInsight {
  verdict: string;
  targeting: string;
  tells: string[];
  recommendedAction: RecommendedAction;
  actionRationale: string;
  confidence: "proven" | "inferred";
}

const CLASS_INTENT: Record<string, string> = {
  exploit_attempt: "active exploitation attempt",
  vuln_scanner: "vulnerability scanner",
  aggressive_scraper: "aggressive scraper",
  form_spammer: "form spammer",
  suspicious: "suspicious automation",
  benign_crawler: "benign crawler",
  unclassified: "unclassified automation",
};
// Worst-first, so the verdict names the most severe class the operator showed.
const CLASS_RANK: Record<string, number> = {
  exploit_attempt: 6, vuln_scanner: 5, aggressive_scraper: 4, form_spammer: 3, suspicious: 2, unclassified: 1, benign_crawler: 0,
};
const SEVERITY_WORD: Record<Severity, string> = { hostile: "hostile", elevated: "elevated-risk", benign: "benign" };

/** One row of the corpus-wide tradecraft ranking: a signal/class/attack tag and
 *  how many DISTINCT operators showed it. */
export interface TradecraftPrevalence {
  tag: string;
  /** Distinct operators (not findings) that exhibited this tag. */
  operators: number;
}

/**
 * Insights over ALL the agents we have encountered, not one at a time. As the
 * dataset grows this is where the pattern surfaces: which tradecraft is most
 * common across every operator (behavior classes + the higher-order insight kinds
 * + named attacks), counted by DISTINCT operators so a single noisy actor cannot
 * dominate the ranking. Pure + deterministic (ties broken by tag name), so it is
 * cheap to compute over the groups already in memory and safe to test. The corpus
 * itself is the durable intel (every journey is persisted); this reads it.
 */
/** The full tradecraft tag-set for one operator: behavior classes + named attacks
 *  + higher-order insight kinds, deduped, minus the empty "unclassified" bucket.
 *  This is the operator's behavioral signature as a set - the unit both the corpus
 *  ranking and the similarity graph are built on. */
export function tellSetOf<T extends OperatorViewJourney>(g: OperatorGroup<T>): Set<string> {
  const tags = new Set<string>();
  for (const c of g.behaviorClasses) if (c && c !== "unclassified") tags.add(c);
  for (const a of g.attacks) if (a) tags.add(`attack:${a}`);
  for (const j of g.journeys) for (const i of j.profile.insights) if (i.kind) tags.add(i.kind);
  return tags;
}

export function aggregateTradecraft<T extends OperatorViewJourney>(groups: readonly OperatorGroup<T>[]): TradecraftPrevalence[] {
  const counts = new Map<string, number>();
  for (const g of groups) {
    // Count each tag at most once per operator (distinct-operator prevalence).
    for (const t of tellSetOf(g)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([tag, operators]) => ({ tag, operators }))
    .sort((a, b) => b.operators - a.operators || a.tag.localeCompare(b.tag));
}

// ---------------------------------------------------------------------------
// Operator similarity graph (shared-tradecraft clustering)
// ---------------------------------------------------------------------------
//
// The reputation network already recognizes an operator by its METHODS, not just
// its fingerprint. This closes the loop inside a workspace: it links operators
// whose tradecraft overlaps into clusters, so a FRESH fingerprint that operates
// like a known-hostile actor surfaces as part of that actor's cluster even when
// the fingerprints differ. As the corpus grows the clusters sharpen - the longer
// it runs, the more coordinated behavior it can see.
//
// This is graph-shaped (operator --shares-tradecraft--> operator), but it is
// modeled here as a pure, deterministic computation over the operators already in
// hand: Postgres is the live source of truth and Neo4j is not configured in
// production (the platform double-writes today), so nothing here depends on a
// graph store. The same edges can fan out to Neo4j through triple-write IF it is
// ever provisioned - as optional enrichment, never a hard dependency.

export interface TradecraftCluster {
  /** The operators linked into this cluster (>= 2). */
  operatorKeys: string[];
  /** Tags shared by at least two members - the tradecraft that links them. */
  sharedTells: string[];
  /** Worst severity among the members. */
  severity: Severity;
  /** Average pairwise similarity (Jaccard over tell-sets), 0..1 - how tight it is. */
  cohesion: number;
  /** True when any member is proven-hostile - the cluster carries a proven core. */
  proven: boolean;
}

/**
 * Cluster operators that share tradecraft. Two operators are linked when their
 * tell-sets share at least `minShared` tags AND their Jaccard similarity is at
 * least `minJaccard` (so a single ubiquitous tag like "vuln_scanner" alone never
 * links everyone). Linked operators are merged transitively (union-find), so a
 * chain of similar actors forms one cluster. Deterministic and pure; ties broken
 * by operator key. Only multi-operator clusters are returned.
 */
export function clusterByTradecraft<T extends OperatorViewJourney>(
  groups: readonly OperatorGroup<T>[],
  opts: { minShared?: number; minJaccard?: number } = {},
): TradecraftCluster[] {
  const minShared = opts.minShared ?? 2;
  const minJaccard = opts.minJaccard ?? 0.34;
  const ops = groups.map((g) => ({ g, set: tellSetOf(g) })).filter((o) => o.set.size > 0);
  const n = ops.length;

  // Union-find over operators.
  const parent = ops.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };

  // Remember each accepted pair's similarity so we can report cluster cohesion.
  const pairJac = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = ops[i].set, b = ops[j].set;
      let inter = 0;
      for (const t of a) if (b.has(t)) inter++;
      if (inter < minShared) continue;
      const jac = inter / (a.size + b.size - inter);
      if (jac < minJaccard) continue;
      union(i, j);
      pairJac.set(`${i}:${j}`, jac);
    }
  }

  // Gather components.
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    (byRoot.get(r) ?? byRoot.set(r, []).get(r)!).push(i);
  }

  const clusters: TradecraftCluster[] = [];
  for (const members of byRoot.values()) {
    if (members.length < 2) continue;
    // sharedTells: tags present in >= 2 members (the connective tradecraft).
    const tagCount = new Map<string, number>();
    for (const m of members) for (const t of ops[m].set) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
    const sharedTells = Array.from(tagCount.entries()).filter(([, c]) => c >= 2).map(([t]) => t).sort();
    // cohesion: mean Jaccard over the member pairs we actually evaluated.
    let sum = 0, cnt = 0;
    for (let x = 0; x < members.length; x++) for (let y = x + 1; y < members.length; y++) {
      const key = `${Math.min(members[x], members[y])}:${Math.max(members[x], members[y])}`;
      if (pairJac.has(key)) { sum += pairJac.get(key)!; cnt++; }
    }
    // SEVERITY_ORDER is 0=hostile (lower is worse), so ascending puts the worst first.
    const severity = members.map((m) => ops[m].g.severity).sort((a, b) => (SEVERITY_ORDER[a] ?? 9) - (SEVERITY_ORDER[b] ?? 9))[0];
    clusters.push({
      operatorKeys: members.map((m) => ops[m].g.operatorKey).sort(),
      sharedTells,
      severity,
      cohesion: cnt > 0 ? Math.round((sum / cnt) * 100) / 100 : 0,
      proven: members.some((m) => ops[m].g.proven),
    });
  }
  return clusters.sort(
    (a, b) => b.operatorKeys.length - a.operatorKeys.length || b.cohesion - a.cohesion || a.operatorKeys[0].localeCompare(b.operatorKeys[0]),
  );
}

// ---------------------------------------------------------------------------
// Campaign detection (coordinated activity)
// ---------------------------------------------------------------------------
//
// A tradecraft cluster says "these operators use the same methods." A CAMPAIGN
// says more: those look-alike operators were also active at the SAME TIME and hit
// the SAME TARGETS - the corroboration that turns "similar" into "coordinated."
// Method-similarity alone can be coincidence (two off-the-shelf scanners); method
// + concurrency + shared targets is a campaign. Pure + deterministic.

export interface Campaign {
  /** The operators acting in concert (>= 2). */
  operatorKeys: string[];
  /** The span the campaign was active across, from the members' sightings. */
  window: { start: string; end: string };
  /** Targets hit by at least two members - the shared objective. */
  sharedTargets: string[];
  /** The tradecraft the members share (from the underlying cluster). */
  sharedTells: string[];
  /** Worst severity among the members. */
  severity: Severity;
  /** True when any member is proven-hostile. */
  proven: boolean;
  /** Peak number of members active simultaneously - the strength of coordination. */
  concurrency: number;
}

/**
 * Find campaigns: tradecraft clusters whose members ALSO overlap in time (within
 * `slackMs`) and share at least one target. A cluster with no shared target, or no
 * concurrent activity, is method-similar but NOT reported as a campaign - we do not
 * overclaim coordination. Deterministic; ties broken by first operator key.
 */
export function detectCampaigns<T extends OperatorViewJourney>(
  groups: readonly OperatorGroup<T>[],
  opts: { minShared?: number; minJaccard?: number; slackMs?: number } = {},
): Campaign[] {
  const slackMs = opts.slackMs ?? 60 * 60 * 1000; // an hour of slack around each window
  const clusters = clusterByTradecraft(groups, opts);
  const byKey = new Map(groups.map((g) => [g.operatorKey, g]));
  const campaigns: Campaign[] = [];

  for (const c of clusters) {
    const members = c.operatorKeys.map((k) => byKey.get(k)).filter((m): m is OperatorGroup<T> => !!m);

    // Shared targets: a path touched by >= 2 members is a shared objective.
    const pathCount = new Map<string, number>();
    for (const m of members) for (const path of new Set(m.paths)) pathCount.set(path, (pathCount.get(path) ?? 0) + 1);
    const sharedTargets = Array.from(pathCount.entries()).filter(([, n]) => n >= 2).map(([p]) => p).sort();
    if (sharedTargets.length === 0) continue; // similar methods, but no common objective

    // Concurrency: peak number of members whose active windows overlap (with slack).
    const iv = members
      .map((m) => ({ s: Date.parse(m.firstSeen), e: Date.parse(m.lastSeen) }))
      .filter((x) => Number.isFinite(x.s) && Number.isFinite(x.e));
    const marks: Array<[number, number]> = [];
    for (const x of iv) { marks.push([x.s - slackMs, 1]); marks.push([x.e + slackMs, -1]); }
    // Sort by time; on a tie, process opens (+1) before closes (-1) so a boundary
    // touch counts as overlap.
    marks.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    let cur = 0, concurrency = 0;
    for (const [, d] of marks) { cur += d; if (cur > concurrency) concurrency = cur; }
    if (concurrency < 2) continue; // similar + same targets, but never active together

    const starts = members.map((m) => m.firstSeen).sort();
    const ends = members.map((m) => m.lastSeen).sort();
    campaigns.push({
      operatorKeys: c.operatorKeys,
      window: { start: starts[0], end: ends[ends.length - 1] },
      sharedTargets,
      sharedTells: c.sharedTells,
      severity: c.severity,
      proven: c.proven,
      concurrency,
    });
  }
  return campaigns.sort(
    (a, b) => b.concurrency - a.concurrency || b.operatorKeys.length - a.operatorKeys.length || a.operatorKeys[0].localeCompare(b.operatorKeys[0]),
  );
}

// ---------------------------------------------------------------------------
// Emerging tradecraft (what is rising)
// ---------------------------------------------------------------------------

export interface TradecraftTrendRow {
  tag: string;
  /** Distinct operators showing this tag whose last activity is in the recent window. */
  recent: number;
  /** Distinct operators showing it whose last activity is before the split. */
  prior: number;
  /** recent - prior: positive = rising. */
  delta: number;
  /** True when it appears only in the recent window (brand-new tradecraft). */
  isNew: boolean;
}

/**
 * What tradecraft is RISING. Operators are bucketed by whether their last activity
 * falls on or after `splitIso` (recent) or before it (prior); each tag is counted
 * by distinct operators in each bucket. As the corpus grows this is the early-
 * warning signal: a tell that is new or climbing among recently-active operators.
 * Pure + deterministic; the caller supplies the split so this stays testable.
 */
export function tradecraftTrend<T extends OperatorViewJourney>(
  groups: readonly OperatorGroup<T>[],
  splitIso: string,
): TradecraftTrendRow[] {
  const split = Date.parse(splitIso);
  const recent = new Map<string, number>();
  const prior = new Map<string, number>();
  for (const g of groups) {
    const t = Date.parse(g.lastSeen);
    const bucket = Number.isFinite(t) && Number.isFinite(split) && t >= split ? recent : prior;
    for (const tag of tellSetOf(g)) bucket.set(tag, (bucket.get(tag) ?? 0) + 1);
  }
  const tags = new Set([...recent.keys(), ...prior.keys()]);
  return Array.from(tags)
    .map((tag) => {
      const r = recent.get(tag) ?? 0;
      const p = prior.get(tag) ?? 0;
      return { tag, recent: r, prior: p, delta: r - p, isNew: p === 0 && r > 0 };
    })
    .sort((a, b) => b.delta - a.delta || a.tag.localeCompare(b.tag));
}

// ---------------------------------------------------------------------------
// Cross-workspace matching (recognize a network actor on first contact)
// ---------------------------------------------------------------------------
//
// The reputation network flags an operator by its FINGERPRINT when another
// workspace has seen that exact fingerprint. This goes further: it matches one of
// YOUR operators against the network's known-hostile actors by their TRADECRAFT,
// so a brand-new fingerprint on your surface is caught the first time it acts if
// it operates like an actor the rest of the network already knows. Day-one benefit
// from everyone's history. Pure + deterministic; the network actors are fetched
// server-side (gated by opt-in) and passed in.

/** One network actor's tradecraft signature, mirrored from the reputation layer
 *  (kept local so this module has no server dependency). */
export interface NetworkActorSignature {
  tells: string[];
  workspaceCount: number;
  severity: Severity;
}

export interface NetworkMatch {
  operatorKey: string;
  /** The tradecraft your operator shares with the matched network actor. */
  sharedTells: string[];
  /** Jaccard similarity to the matched actor, 0..1. */
  similarity: number;
  /** How many other workspaces corroborated the matched actor. */
  networkWorkspaces: number;
  severity: Severity;
}

/**
 * Match your operators against the network's known-hostile actors by tradecraft.
 * An operator matches when it shares at least `minShared` tells with an actor AND
 * their Jaccard similarity is at least `minJaccard` (so a single common tag never
 * matches). Each operator keeps only its single best match. Deterministic; ties
 * broken by operator key. Returns only operators that matched.
 */
export function matchOperatorsToNetwork<T extends OperatorViewJourney>(
  groups: readonly OperatorGroup<T>[],
  network: readonly NetworkActorSignature[],
  opts: { minShared?: number; minJaccard?: number } = {},
): NetworkMatch[] {
  const minShared = opts.minShared ?? 2;
  const minJaccard = opts.minJaccard ?? 0.34;
  const actors = network.map((a) => ({ ...a, set: new Set(a.tells) })).filter((a) => a.set.size > 0);
  const matches: NetworkMatch[] = [];
  for (const g of groups) {
    const mine = tellSetOf(g);
    if (mine.size === 0) continue;
    let best: NetworkMatch | null = null;
    for (const a of actors) {
      let inter = 0;
      for (const t of mine) if (a.set.has(t)) inter++;
      if (inter < minShared) continue;
      const jac = inter / (mine.size + a.set.size - inter);
      if (jac < minJaccard) continue;
      if (!best || jac > best.similarity || (jac === best.similarity && a.workspaceCount > best.networkWorkspaces)) {
        best = {
          operatorKey: g.operatorKey,
          sharedTells: Array.from(mine).filter((t) => a.set.has(t)).sort(),
          similarity: Math.round(jac * 100) / 100,
          networkWorkspaces: a.workspaceCount,
          severity: a.severity,
        };
      }
    }
    if (best) matches.push(best);
  }
  return matches.sort((a, b) => b.similarity - a.similarity || b.networkWorkspaces - a.networkWorkspaces || a.operatorKey.localeCompare(b.operatorKey));
}

/** Synthesize one operator group into a decision-ready brief. Deterministic. */
export function deriveOperatorInsight<T extends OperatorViewJourney>(g: OperatorGroup<T>): OperatorInsight {
  const confidence: "proven" | "inferred" = g.proven ? "proven" : "inferred";
  const primaryClass = [...g.behaviorClasses].sort((a, b) => (CLASS_RANK[b] ?? 0) - (CLASS_RANK[a] ?? 0))[0] ?? "unclassified";
  const intent = CLASS_INTENT[primaryClass] ?? primaryClass.replace(/_/g, " ");
  const verdict = `${confidence === "proven" ? "Proven" : "Likely"} ${SEVERITY_WORD[g.severity]} ${intent}`;

  // What it targets, in the reused probe-signature vocabulary.
  const cats = g.targeting.categories.map((c) => (c.count > 1 ? `${c.category} (${c.count})` : c.category));
  const parts: string[] = [];
  if (cats.length) parts.push(`targets ${cats.join(", ")}`);
  if (g.targeting.payloadTypes.length) parts.push(`sends ${g.targeting.payloadTypes.join(", ")}`);
  if (g.paths.length) parts.push(`hit ${g.paths.slice(0, 4).join(", ")}${g.paths.length > 4 ? "..." : ""}`);
  const targeting = parts.join("; ") || "no distinctive targeting yet";

  // The higher-order tells, deduped across the group's journeys.
  const kinds = new Set(g.journeys.flatMap((j) => j.profile.insights.map((i) => i.kind)));
  const tells: string[] = [];
  if (kinds.has("impersonation")) tells.push("Wears a known good-bot's identity while behaving hostilely (impersonation)");
  if (kinds.has("deliberate_violation")) tells.push("Read robots.txt, then broke the rules on purpose (deliberate)");
  if (kinds.has("payload_attack")) {
    const a = Array.from(new Set(g.attacks));
    tells.push(`Sent live ${a.length ? a.join(" / ") : "injection"} payloads`);
  }
  if (kinds.has("id_enumeration")) tells.push("Walked sequential object IDs (IDOR enumeration)");
  if (kinds.has("runaway_loop")) tells.push("Hammered one endpoint in a loop (resource exhaustion)");
  if (g.subActors.length > 1) tells.push(`${g.subActors.length} distinguishable targeting profiles under this fingerprint`);
  if (g.grouping === "coarse") tells.push("Coarse fingerprint: grouping is likely, not proven");

  // Recommended action: deterministic from severity + proof. A block is only
  // recommended on PROVEN-hostile behavior; hostile-but-inferred escalates first.
  let recommendedAction: RecommendedAction;
  let actionRationale: string;
  if (g.severity === "hostile" && g.proven) {
    recommendedAction = "block";
    actionRationale = "Proven-hostile behavior a legitimate client never shows. Block the operator fingerprint.";
  } else if (g.severity === "hostile") {
    recommendedAction = "escalate";
    actionRationale = "Hostile behavior, but the grouping is inferred. Escalate to confirm before blocking.";
  } else if (g.severity === "elevated") {
    recommendedAction = "escalate";
    actionRationale = "Elevated-risk signals worth a human look.";
  } else if (primaryClass === "benign_crawler") {
    recommendedAction = "acknowledge";
    actionRationale = "Identified, rule-respecting crawler. Acknowledge and move on.";
  } else {
    recommendedAction = "watch";
    actionRationale = "Weak signals only. Keep watching for escalation.";
  }

  return { verdict, targeting, tells, recommendedAction, actionRationale, confidence };
}

// ── Agent trust score + intent (the market's "intent visibility") ────────────
// A deterministic 0-100 trust score and an explicit INTENT for an operator,
// synthesized from the signals we already hold: behavior class, proven-vs-
// inferred, the higher-order insights (impersonation, deliberate violation,
// payloads, IDOR enumeration, runaway loops), and targeting severity. This is
// the industry's crown criterion ("what is it trying to do, and how much do I
// trust it") - answered deterministically, so the score is reproducible and
// auditable, never a black-box guess. Pure.

export type TrustBand = "trusted" | "caution" | "untrusted" | "hostile";

export type AgentIntent =
  | "mandate_violation"
  | "authorized_delegation"
  | "legitimate_crawl"
  | "content_harvesting"
  | "vulnerability_recon"
  | "access_probing"
  | "active_exploitation"
  | "impersonation"
  | "resource_abuse"
  | "form_abuse"
  | "unclear";

export interface AgentTrustProfile {
  /** 0 (hostile) to 100 (fully trusted). */
  score: number;
  band: TrustBand;
  /** What the agent is trying to DO, not just its threat class. */
  intent: AgentIntent;
  intentLabel: string;
  intentConfidence: "proven" | "inferred";
  rationale: string;
}

const INTENT_LABEL: Record<AgentIntent, string> = {
  mandate_violation: "Authorized agent exceeding its mandate",
  authorized_delegation: "Authorized delegated access",
  legitimate_crawl: "Legitimate crawl",
  content_harvesting: "Content harvesting",
  vulnerability_recon: "Vulnerability reconnaissance",
  access_probing: "Access-control probing (IDOR)",
  active_exploitation: "Active exploitation",
  impersonation: "Evasion via impersonation",
  resource_abuse: "Resource abuse",
  form_abuse: "Form abuse / spam",
  unclear: "Unclear (low signal)",
};

// Base trust contribution of the worst behavior class the operator showed.
const CLASS_TRUST: Record<string, number> = {
  benign_crawler: 38,
  suspicious: -3,
  unclassified: -3,
  form_spammer: -30,
  aggressive_scraper: -35,
  vuln_scanner: -40,
  exploit_attempt: -50,
};
const CLASS_RANK_TRUST: Record<string, number> = {
  exploit_attempt: 6, vuln_scanner: 5, aggressive_scraper: 4, form_spammer: 3, suspicious: 2, unclassified: 1, benign_crawler: 0,
};

function clamp01to100(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Synthesize an operator's trust score + intent. Deterministic. */
export function deriveTrustProfile<T extends OperatorViewJourney>(g: OperatorGroup<T>): AgentTrustProfile {
  const kinds = new Set(g.journeys.flatMap((j) => j.profile.insights.map((i) => i.kind)));
  const classes = g.behaviorClasses;
  const worstClass = [...classes].sort((a, b) => (CLASS_RANK_TRUST[b] ?? 0) - (CLASS_RANK_TRUST[a] ?? 0))[0] ?? "unclassified";

  // Score: an unknown baseline moved by the worst class + compounding hostile
  // tells + certainty + targeting severity.
  let score = 55 + (CLASS_TRUST[worstClass] ?? 0);
  if (kinds.has("payload_attack")) score -= 20;
  if (kinds.has("impersonation")) score -= 25; // wearing a disguise is maximally untrustworthy
  if (kinds.has("deliberate_violation")) score -= 15;
  if (kinds.has("id_enumeration")) score -= 15;
  if (kinds.has("runaway_loop")) score -= 10;
  if (kinds.has("mandate_exceeded")) score -= 30; // had authorization and abused it
  if (kinds.has("principal_unverifiable")) score -= 12; // claimed a right it cannot prove
  if (kinds.has("principal_verified")) score += 25; // proven accountable principal, in-scope
  if (g.proven && g.severity === "hostile") score -= 8; // certain-bad pushes further down
  if (worstClass === "benign_crawler" && g.proven) score += 7; // certain-good rewarded
  if (g.targeting.topSeverity === "critical") score -= 8;
  else if (g.targeting.topSeverity === "high") score -= 4;
  score = clamp01to100(score);

  const band: TrustBand = score >= 75 ? "trusted" : score >= 50 ? "caution" : score >= 25 ? "untrusted" : "hostile";

  // Intent: what it is trying to do, worst-first.
  let intent: AgentIntent;
  if (kinds.has("mandate_exceeded")) intent = "mandate_violation";
  else if (kinds.has("payload_attack") || classes.includes("exploit_attempt")) intent = "active_exploitation";
  else if (kinds.has("impersonation")) intent = "impersonation";
  else if (kinds.has("id_enumeration")) intent = "access_probing";
  else if (classes.includes("vuln_scanner")) intent = "vulnerability_recon";
  else if (kinds.has("runaway_loop")) intent = "resource_abuse";
  else if (classes.includes("form_spammer")) intent = "form_abuse";
  else if (classes.includes("aggressive_scraper")) intent = "content_harvesting";
  else if (classes.includes("benign_crawler")) intent = "legitimate_crawl";
  else if (kinds.has("principal_verified")) intent = "authorized_delegation";
  else intent = "unclear";

  const intentConfidence: "proven" | "inferred" = g.proven ? "proven" : "inferred";
  const rationale =
    intent === "legitimate_crawl"
      ? "Identified and rule-respecting; no hostile behavior observed."
      : `${intentConfidence === "proven" ? "Proven" : "Likely"} ${INTENT_LABEL[intent].toLowerCase()}${g.targeting.topSeverity !== "none" ? `, targeting ${g.targeting.topSeverity}-severity surfaces` : ""}.`;

  return { score, band, intent, intentLabel: INTENT_LABEL[intent], intentConfidence, rationale };
}
