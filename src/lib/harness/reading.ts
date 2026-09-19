/**
 * Build an honest behavioral reading from a harness session's recorded hits.
 *
 * PURE. Given the ordered hits an external agent made against the sandbox, it
 * reconstructs a ProbeRun and runs it through the SAME engine that scores live
 * traffic - deriveScaffoldingSignature (how it is built), buildJourneys (what it
 * did), analyzeToolComposition (what it exercised), buildDossier (fused, keyed to
 * a durable operator fingerprint). Nothing is re-implemented here; this only
 * adapts stored hits into the engine's inputs, so the harness can never drift
 * from production. The proven-vs-inferred rail and the "not a real-world
 * identity" disclaimer come through from the engine unchanged.
 */

import { deriveScaffoldingSignature, type ProbeRun, type ScaffoldingSignature } from "@/lib/agent-probe";
import { buildJourneys, type AgentJourney } from "@/lib/agent-behavior";
import { analyzeToolComposition } from "@/lib/agent-tool-composition";
import { buildDossier, type AttributionDossier, type Sighting } from "@/lib/agent-dossier";
import { sandboxLinks } from "@/lib/harness/sandbox";

export interface HarnessHit {
  path: string;
  method: string;
  status: number;
  eventType: string | null;
  at: string;
}

export interface HarnessReading {
  sessionId: string;
  surface: string;
  agentLabel: string;
  goal: string;
  hitCount: number;
  journey: AgentJourney;
  scaffolding: ScaffoldingSignature;
  dossier: AttributionDossier;
  /** The fused sighting the dossier was built from - reused by the DB layer to
   *  capture the run into learning without recomputation. */
  sighting: Sighting;
  /** One plain-language line for the top of the UI. */
  headline: string;
}

/** Reconstruct the scaffolding-level ProbeRun from stored hits. A hit is a
 *  FOLLOWED link if its path was linked from a page served earlier this session
 *  (same rule as the live runner: links are revealed as pages are served); the
 *  entry point and anything else is treated as the agent's own move. */
export function reconstructRun(sessionId: string, agentLabel: string, goal: string, surface: string, hits: readonly HarnessHit[]): ProbeRun {
  const seenLinks = new Set<string>();
  const steps = hits.map((h, i) => {
    const followedLink = seenLinks.has(h.path);
    for (const l of sandboxLinks(h.path)) seenLinks.add(l);
    return { step: i, path: h.path, followedLink, status: h.status, at: h.at };
  });
  return { runId: sessionId, agentLabel, goal, base: surface, steps };
}

/** The toolset we can HONESTLY attribute from HTTP observation alone: a fetch
 *  tool always, plus a form submitter if the agent actually POSTed a form. We do
 *  not invent tools we cannot see. */
function observedTools(hits: readonly HarnessHit[]): string[] {
  const tools = ["fetch"];
  if (hits.some((h) => h.method.toUpperCase() === "POST")) tools.push("submit_form");
  return tools;
}

export function buildHarnessReading(input: {
  sessionId: string;
  agentLabel: string;
  goal: string;
  surface: string;
  hits: readonly HarnessHit[];
}): HarnessReading {
  const { sessionId, agentLabel, goal, surface, hits } = input;
  const sorted = [...hits].sort((a, b) => a.at.localeCompare(b.at));

  const run = reconstructRun(sessionId, agentLabel, goal, surface, sorted);
  const scaffolding = deriveScaffoldingSignature(run);

  // Journey: map each hit to its structural event (a plain page view uses a
  // non-signal type so it still contributes to the path). The session is
  // nonce-correlated - the agent carried our unguessable session token - so the
  // journey is PROVEN one actor, not a fingerprint guess.
  const journeys = buildJourneys(
    sorted.map((h) => ({ key: sessionId, keyKind: "nonce" as const, type: h.eventType ?? "site.page_viewed", path: h.path, at: h.at })),
  );
  const journey = journeys[0] ?? {
    key: sessionId, confidence: "proven" as const, behaviorClass: "unclassified" as const,
    signals: [], path: [], eventCount: 0, firstAt: "", lastAt: "", summary: "No requests recorded yet.",
  };

  const tools = analyzeToolComposition(observedTools(sorted));
  const at = journey.lastAt || journey.firstAt || "";
  const sighting: Sighting = { surface, at, journey, scaffolding, tools };
  const dossier = buildDossier([sighting]);

  return {
    sessionId,
    surface,
    agentLabel,
    goal,
    hitCount: sorted.length,
    journey,
    scaffolding,
    dossier,
    sighting,
    headline: journey.summary,
  };
}
