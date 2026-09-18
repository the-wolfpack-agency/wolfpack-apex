/**
 * Agent-vs-site probe harness - test how an agent behaves on an instrumented
 * surface, and (the novel part) fingerprint its SCAFFOLDING, not just its model.
 *
 * An agent is a model wrapped in scaffolding: a fetch client, a tool-calling
 * loop, a path-discovery strategy, retry logic. The model is the interchangeable
 * part; the scaffolding is the operator's choice and it leaves the richer, more
 * durable trace. Two operators can run the same model and behave completely
 * differently; one operator keeps the same behavior across models. So the trace
 * that matters for detection AND provenance lives in the scaffolding.
 *
 * This harness drives an agent (injected, so any model/framework or a mock plugs
 * in) against a target, records every fetch as a step tagged with whether the
 * path was DISCOVERED from a prior page or GUESSED, and derives:
 *   - the behavior class, via the SAME classifier used on live traffic (the
 *     shared spine - a scraper is a scraper whether caught in the wild or here),
 *   - a scaffolding signature: reads-robots-first, path-discovery strategy
 *     (link-following vs path-guessing), retries, sensitive probing.
 *
 * Deterministic + injected deps (driver, fetch, clock), so it is fully unit-
 * testable with no network and no live model. SSRF-guarded: an agent under test
 * can never make the harness reach outside the target origin.
 */

import { buildJourneys, type AgentJourney } from "@/lib/agent-behavior";

/** Recon paths a site does not legitimately serve; requesting one is guessing. */
export const SENSITIVE_PROBE_PATHS: readonly string[] = [
  "/admin", "/administrator", "/wp-admin", "/wp-login.php", "/xmlrpc.php",
  "/.env", "/.git", "/.aws", "/.ssh", "/config", "/config.json", "/phpmyadmin",
  "/server-status", "/actuator", "/backup", "/vendor", "/debug", "/console",
];

export function isSensitiveProbe(path: string): boolean {
  const p = (path || "").toLowerCase();
  return SENSITIVE_PROBE_PATHS.some((s) => p === s || p.startsWith(`${s}/`) || p.startsWith(`${s}.`));
}

/** Map a fetched path to the Forcefield signal event it represents, so the shared
 *  classifier can score a harness run exactly like live traffic. */
export function signalEventForPath(path: string): string | null {
  const p = (path || "").split("?")[0];
  if (p === "/_ff" || p.startsWith("/_ff/")) return "site.agent_trap_tripped";
  if (p === "/robots.txt") return "site.agent_read_robots";
  if (p === "/sitemap.xml") return "site.agent_read_sitemap";
  if (isSensitiveProbe(p)) return "site.agent_probed_sensitive";
  return null; // a normal page: part of the path, not a signal
}

/** Only same-origin http(s) URLs within the target base are allowed. Blocks an
 *  agent-under-test from turning the harness into an SSRF pivot. */
export function isWithinBase(rawUrl: string, base: string): boolean {
  let u: URL, b: URL;
  try {
    b = new URL(base);
    u = new URL(rawUrl, base);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return u.host === b.host && u.protocol === b.protocol;
}

/** Extract link paths from an HTML body, so the runner can tell a followed link
 *  from a guessed path. Deliberately simple (href="..."), lowercased paths. */
export function extractLinkPaths(html: string, base: string): string[] {
  const out: string[] = [];
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      out.push(new URL(m[1], base).pathname);
    } catch {
      /* skip un-parseable href */
    }
  }
  return out;
}

export interface ProbeStep {
  step: number;
  path: string;
  /** True when this path appeared as a link on a page fetched earlier (the agent
   *  FOLLOWED it); false when it never appeared and was GUESSED. */
  followedLink: boolean;
  status: number;
  at: string;
}

export interface ProbeRun {
  runId: string;
  /** Label of the agent under test - "gpt-5 + langchain", "claude + custom", etc. */
  agentLabel: string;
  goal: string;
  base: string;
  steps: ProbeStep[];
}

export interface ScaffoldingSignature {
  stepCount: number;
  /** Its first move was to read robots.txt (a rule-respecting scaffolding). */
  readsRobotsFirst: boolean;
  followedLinks: number;
  guessedPaths: number;
  /** How it discovers where to go - the framework fingerprint. */
  pathDiscovery: "link-following" | "path-guessing" | "mixed" | "none";
  /** Re-requested a path after a non-200 (retry logic in the scaffolding). */
  retries: boolean;
  probedSensitive: boolean;
}

export interface ProbeDriverCtx {
  goal: string;
  base: string;
  history: readonly ProbeStep[];
  lastBody: string | null;
}

export interface RunProbeOptions {
  runId: string;
  agentLabel: string;
  goal: string;
  base: string;
  /** The agent under test: returns the next path/URL to fetch, or null to stop. */
  driver: (ctx: ProbeDriverCtx) => Promise<string | null>;
  /** Fetch the target. Injected so tests need no network; live wiring uses fetch. */
  fetchImpl: (url: string) => Promise<{ status: number; body: string }>;
  /** Injected clock for deterministic tests. */
  clock?: () => string;
  maxSteps?: number;
}

/**
 * Run one agent against the target, capturing the scaffolding-level trace. The
 * driver proposes paths; the runner fetches (SSRF-guarded), tags each as
 * followed-vs-guessed by tracking links seen so far, and stops on null / cap /
 * an out-of-base attempt.
 */
export async function runAgentProbe(opts: RunProbeOptions): Promise<ProbeRun> {
  const clock = opts.clock ?? (() => new Date().toISOString());
  const maxSteps = Math.max(1, Math.min(opts.maxSteps ?? 20, 100));
  const seenLinkPaths = new Set<string>();
  const steps: ProbeStep[] = [];
  let lastBody: string | null = null;

  for (let i = 0; i < maxSteps; i++) {
    const proposed = await opts.driver({ goal: opts.goal, base: opts.base, history: steps, lastBody });
    if (!proposed) break;
    if (!isWithinBase(proposed, opts.base)) break; // SSRF guard: stop, do not fetch

    const path = new URL(proposed, opts.base).pathname;
    const followedLink = seenLinkPaths.has(path);
    const { status, body } = await opts.fetchImpl(new URL(proposed, opts.base).toString());
    steps.push({ step: i, path, followedLink, status, at: clock() });
    for (const p of extractLinkPaths(body, opts.base)) seenLinkPaths.add(p);
    lastBody = body;
  }

  return { runId: opts.runId, agentLabel: opts.agentLabel, goal: opts.goal, base: opts.base, steps };
}

/** Derive the scaffolding fingerprint from a run. */
export function deriveScaffoldingSignature(run: ProbeRun): ScaffoldingSignature {
  const steps = run.steps;
  const followedLinks = steps.filter((s) => s.followedLink).length;
  // A guessed path is one not discovered from a page - excluding the very first
  // entry point, which the agent is given rather than guessing.
  const guessedPaths = steps.slice(1).filter((s) => !s.followedLink).length;
  const seen = new Set<string>();
  let retries = false;
  for (const s of steps) {
    if (seen.has(s.path)) retries = true;
    seen.add(s.path);
  }
  let pathDiscovery: ScaffoldingSignature["pathDiscovery"];
  if (steps.length <= 1) pathDiscovery = "none";
  else if (guessedPaths > 0 && followedLinks > 0) pathDiscovery = "mixed";
  else if (guessedPaths > 0) pathDiscovery = "path-guessing";
  else pathDiscovery = "link-following";

  return {
    stepCount: steps.length,
    readsRobotsFirst: steps[0]?.path === "/robots.txt",
    followedLinks,
    guessedPaths,
    pathDiscovery,
    retries,
    probedSensitive: steps.some((s) => isSensitiveProbe(s.path)),
  };
}

export interface ProbeReport {
  run: ProbeRun;
  /** Behavior class from the SHARED classifier - same as live traffic. Proven,
   *  because the harness knows for certain these steps are one agent. */
  journey: AgentJourney;
  scaffolding: ScaffoldingSignature;
}

/** Score a run: map its steps to Forcefield signals, classify with the shared
 *  spine, and attach the scaffolding fingerprint. */
export function reportProbeRun(run: ProbeRun): ProbeReport {
  const rows = run.steps.map((s) => ({
    key: run.runId, // one agent, known for certain -> proven correlation
    keyKind: "nonce" as const,
    type: signalEventForPath(s.path) ?? "site.page_viewed",
    path: s.path,
    at: s.at,
    nonceLinked: true,
  }));
  const journey = buildJourneys(rows)[0] ?? {
    key: run.runId,
    confidence: "proven" as const,
    behaviorClass: "unclassified" as const,
    signals: [],
    path: [],
    eventCount: 0,
    firstAt: "",
    lastAt: "",
    summary: "No steps recorded.",
  };
  return { run, journey, scaffolding: deriveScaffoldingSignature(run) };
}
