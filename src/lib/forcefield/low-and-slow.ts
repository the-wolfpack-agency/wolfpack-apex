/**
 * Low-and-slow detection benchmark (gap #4). Detection here is behavioral +
 * deception, which a GREEDY agent trips but a PATIENT, decoy-avoiding, human-
 * paced one can evade. Rather than pretend we catch everything, we MEASURE it:
 * a fixed set of adversary profiles run through the real classifier, and we
 * report honestly which are detected and which slip through. The residual gap is
 * named, not hidden - the anti-overclaim posture the red-team demanded.
 *
 * Pure + deterministic (drives the real classifySession).
 */
import { classifySession, type SessionEvent, type AgentJourney } from "@/lib/agent-behavior";

export interface ProfileResult {
  id: string;
  name: string;
  /** True for the human-paced / evasive profiles (the hard cases). */
  evasive: boolean;
  detected: boolean;
  outcome: string;
}

export interface LowAndSlowReport {
  profiles: ProfileResult[];
  detected: number;
  total: number;
  /** Detection rate over ALL profiles, 0-100. */
  rate: number;
  /** Detection rate over the EVASIVE profiles only - the honest hard number. */
  evasiveRate: number;
  note: string;
}

let clk = 0;
function ev(type: string, path: string, extra: Partial<SessionEvent> = {}): SessionEvent {
  clk += 60_000; // one minute apart: "slow" by construction
  return { type, path, at: new Date(1_700_000_000_000 + clk).toISOString(), ...extra };
}
function run(events: SessionEvent[]): AgentJourney {
  return classifySession({ key: "bench", keyKind: "fingerprint", events });
}
/** Detected = the classifier raised something actionable (not a plain visitor). */
function isDetected(j: AgentJourney): boolean {
  const hostileClasses = new Set(["aggressive_scraper", "exploit_attempt", "vuln_scanner", "form_spammer", "suspicious"]);
  return j.confidence === "proven" || hostileClasses.has(j.behaviorClass) || j.insights.length > 0;
}

export function benchmarkLowAndSlow(): LowAndSlowReport {
  clk = 0;
  const cases: Array<{ id: string; name: string; evasive: boolean; events: SessionEvent[] }> = [
    // Detectable regardless of pace (deception + structural signals):
    { id: "greedy-decoy", name: "Greedy scraper (trips the invisible decoy)", evasive: false, events: [ev("site.agent_trap_tripped", "/_ff/trap"), ev("site.page_viewed", "/a")] },
    { id: "sensitive-prober", name: "Sensitive-path prober (/admin, /.env)", evasive: false, events: [ev("site.agent_probed_sensitive", "/.env"), ev("site.agent_probed_sensitive", "/wp-login.php")] },
    { id: "slow-enumerator", name: "Slow IDOR enumeration (paced, still sequential)", evasive: true, events: [ev("site.page_viewed", "/api/u/1"), ev("site.page_viewed", "/api/u/2"), ev("site.page_viewed", "/api/u/3")] },
    { id: "form-honeypot", name: "Form bot (fills the hidden field)", evasive: false, events: [ev("site.agent_form_honeypot", "/contact")] },
    // The HARD cases - honestly reported:
    { id: "patient-passive", name: "Patient passive reader (human-paced plain visits)", evasive: true, events: [ev("site.page_viewed", "/"), ev("site.page_viewed", "/pricing"), ev("site.page_viewed", "/faq")] },
    { id: "decoy-avoider", name: "Careful scraper (avoids the decoy, no sensitive probes)", evasive: true, events: [ev("site.page_viewed", "/blog/1"), ev("site.page_viewed", "/blog/two"), ev("site.page_viewed", "/about")] },
  ];

  const profiles: ProfileResult[] = cases.map((c) => {
    const j = run(c.events);
    const detected = isDetected(j);
    return { id: c.id, name: c.name, evasive: c.evasive, detected, outcome: `${j.behaviorClass}${j.confidence === "proven" ? " (proven)" : ""}` };
  });

  const detected = profiles.filter((p) => p.detected).length;
  const evasive = profiles.filter((p) => p.evasive);
  const evasiveDetected = evasive.filter((p) => p.detected).length;
  const rate = Math.round((detected / profiles.length) * 100);
  const evasiveRate = evasive.length ? Math.round((evasiveDetected / evasive.length) * 100) : 0;

  return {
    profiles, detected, total: profiles.length, rate, evasiveRate,
    note: "A truly passive, decoy-avoiding, human-paced agent is the residual gap: with no structural tell and no trap tripped, it reads as a normal visitor. Detection here is behavioral + deception, not a guarantee - so we measure and report it rather than claim 100%. Improvement path: more decoys across surfaces, and rotation-resistant fingerprinting (JA4 / timing), added only if precision holds.",
  };
}
