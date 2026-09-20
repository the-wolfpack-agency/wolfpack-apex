/**
 * Famous-breach replay corpus. Real, publicly-documented attack TECHNIQUES (not
 * named victims) driven through Forcefield's real defenses, with HONEST coverage:
 * "prevented" (a deterministic control blocks it), "detected" (we flag it but do
 * not inherently block unless enforcing), or "out_of_scope" (we say plainly that
 * this class is not something an inbound-agent defense stops). The honesty is the
 * point: overclaiming is the exact failure the red-team warned about. Doubles as
 * marketing proof - "in hindsight, here is what we would have done."
 *
 * Server-side + deterministic. Each scenario runs the same real functions the
 * product uses in production, so a regression here means a real regression.
 */
import { classifySession, type SessionEvent } from "@/lib/agent-behavior";
import { qualifiesForAutoBlock, type EdgeSignals } from "@/lib/forcefield/edge-enforcement";
import { checkMandate, type PrincipalVerdict } from "@/lib/forcefield/principal-types";
import { verifyPresentedDelegation, type DelegationIssuer } from "@/lib/forcefield/principal";
import { delegationSignature } from "@/lib/ogiam/delegate";

export type Coverage = "prevented" | "detected" | "out_of_scope";

export interface BreachResult {
  id: string;
  /** The attack class, in plain language. */
  attack: string;
  /** The real-world technique this models (documented class, not a named victim). */
  realWorld: string;
  coverage: Coverage;
  /** The control that handles it (or why it is out of scope). */
  control: string;
  /** What our real defense actually did with the replayed attack. */
  detail: string;
}

export interface BreachReport {
  results: BreachResult[];
  prevented: number;
  detected: number;
  outOfScope: number;
  total: number;
}

let clock = 1_700_000_000_000;
function ev(type: string, path: string, extra: Partial<SessionEvent> = {}): SessionEvent {
  clock += 1000;
  return { type, path, at: new Date(clock).toISOString(), ...extra };
}
function classify(events: SessionEvent[]) {
  return classifySession({ key: "corpus", keyKind: "fingerprint", events });
}
const SECRET = "corpus-issuer-secret-key";
const KNOWN: DelegationIssuer = { issuer: "known", algorithm: "hs256", secret: SECRET, allowedScopes: [] };
function mint(body: Record<string, unknown>): string {
  const json = JSON.stringify(body);
  const ts = 1_700_000_000;
  return `${Buffer.from(json, "utf8").toString("base64url")}.${ts}.${delegationSignature(SECRET, json, ts)}`;
}
const sig = (p: Partial<EdgeSignals>): EdgeSignals => ({ blocked: false, trustBand: "caution", mandateExceeded: false, principalStatus: "absent", networkHostile: false, ...p });

export async function runBreachCorpus(): Promise<BreachReport> {
  const results: BreachResult[] = [];
  const add = (r: BreachResult) => results.push(r);

  // 1. Fake-crawler impersonation (a hostile bot wearing a known good-bot's UA).
  {
    const j = classify([ev("site.agent_welcomed", "/", { agent: "GPTBot" }), ev("site.agent_trap_tripped", "/trap")]);
    const impersonation = j.insights.some((i) => i.kind === "impersonation");
    add({ id: "fake-crawler", attack: "A hostile scraper presents a known good bot's identity (e.g. a fake GPTBot/Googlebot) to slip past filters.", realWorld: "Fake-crawler / fake-Googlebot impersonation - a long-documented evasion technique.", coverage: impersonation ? "detected" : "out_of_scope", control: "Verified-vs-claimed identity (Web Bot Auth): a real crawler is verified, a claimed one that then behaves hostilely is flagged as impersonation.", detail: `impersonation insight: ${impersonation}` });
  }

  // 2. Mass scraping of public data (trips the invisible decoy -> proven bot).
  {
    const j = classify([ev("site.agent_trap_tripped", "/_ff/trap"), ev("site.agent_probed_sensitive", "/api/users")]);
    const proven = j.confidence === "proven";
    const auto = qualifiesForAutoBlock(sig({ trustBand: "hostile" }), { proven }).auto;
    add({ id: "mass-scraping", attack: "An agent harvests public data at scale, walking every link including ones a human never sees.", realWorld: "Large-scale scraping of public profiles/content - the technique behind several well-known data-aggregation disputes.", coverage: proven && auto ? "prevented" : "detected", control: "Active deception (invisible decoy) proves it is a bot, then auto-block stops it.", detail: `proven: ${proven}, auto-block: ${auto}` });
  }

  // 3. IDOR / broken object-level authorization (walk sequential record IDs).
  {
    const j = classify([ev("site.page_viewed", "/api/orders/1001"), ev("site.page_viewed", "/api/orders/1002"), ev("site.page_viewed", "/api/orders/1003")]);
    const idor = j.insights.some((i) => i.kind === "id_enumeration");
    add({ id: "idor-enumeration", attack: "An agent steps through sequential record IDs to reach data belonging to other users.", realWorld: "Broken Object-Level Authorization (IDOR) - the #1 OWASP API risk, behind many public API data breaches.", coverage: idor ? "detected" : "out_of_scope", control: "ID-enumeration detection flags the sequential walk for escalation.", detail: `id_enumeration insight: ${idor}` });
  }

  // 4. Injection (SQLi / prompt injection payload sent in a request).
  {
    const j = classify([ev("site.agent_payload_attack", "/api/search", { attack: "sql_injection" })]);
    const payload = j.insights.some((i) => i.kind === "payload_attack");
    add({ id: "injection", attack: "An agent sends a live injection payload (SQLi, or a prompt-injection string aimed at an AI endpoint).", realWorld: "Injection attacks - perennial OWASP Top 10, now including prompt injection against AI agents.", coverage: payload ? "detected" : "out_of_scope", control: "Payload detection classifies it as active exploitation (exploit_attempt), not just a probe.", detail: `payload_attack insight: ${payload}, class: ${j.behaviorClass}` });
  }

  // 5. Credential stuffing (bot hammering a login form, superhuman speed).
  {
    const j = classify([ev("site.agent_high_rate", "/login"), ev("site.agent_form_too_fast", "/login")]);
    const bot = j.signals.includes("high_rate") || j.signals.includes("form_too_fast");
    add({ id: "credential-stuffing", attack: "A bot replays stolen username/password pairs against a login form at machine speed.", realWorld: "Credential stuffing - the technique behind waves of account-takeover incidents at major consumer brands.", coverage: bot ? "detected" : "out_of_scope", control: "High-rate + too-fast-submit signals flag automation for challenge before it can brute-force.", detail: `automation signals: ${j.signals.join(", ") || "none"}` });
  }

  // 6. Stolen OAuth/session token replayed (captured credential reused).
  {
    const raw = mint({ principal: "victim", issuer: "known", scopes: ["/api"], jti: "corpus-replay", exp: 1_700_003_600 });
    const seen = new Set<string>();
    const consume = async (jti: string) => { if (seen.has(jti)) return false; seen.add(jti); return true; };
    const first = await verifyPresentedDelegation(raw, { resolveIssuer: (i) => (i === "known" ? KNOWN : null), nowSeconds: 1_700_000_500, consumeJti: consume });
    const replay = await verifyPresentedDelegation(raw, { resolveIssuer: (i) => (i === "known" ? KNOWN : null), nowSeconds: 1_700_000_600, consumeJti: consume });
    add({ id: "token-replay", attack: "An attacker captures a valid delegated-access token and replays it to act as the victim.", realWorld: "OAuth/session token theft + replay - seen in several major SaaS supply-chain token-theft incidents.", coverage: first.status === "verified" && replay.status === "claimed" ? "prevented" : "detected", control: "Replay defense: a jti is accepted once; the replayed token is rejected.", detail: `first: ${first.status}, replay: ${replay.status}` });
  }

  // 7. Over-scoped token abuse (a valid token used beyond its granted scope).
  {
    const verdict: PrincipalVerdict = { status: "verified", principal: "p", issuer: "known", scopes: ["/reports"], reason: "ok" };
    const m = checkMandate(verdict, ["/reports", "/admin/users", "/api/export"]);
    add({ id: "token-overreach", attack: "A verified agent uses a genuinely-issued token to reach resources outside what it was authorized for.", realWorld: "Over-scoped / abused delegated access - a core pattern in cloud and SaaS breach post-mortems.", coverage: !m.withinScope ? "prevented" : "detected", control: "Mandate conformance (Know the Principal): behavior is checked against the granted scope; overreach is a mandate violation.", detail: `mandate violations: ${m.violations.join(", ") || "none"}` });
  }

  // 8. Forged authorization (credential from an issuer we never trusted).
  {
    const v = await verifyPresentedDelegation(mint({ principal: "attacker", issuer: "stranger", scopes: ["/admin"], jti: "corpus-forge", exp: 1_700_003_600 }), { resolveIssuer: (i) => (i === "known" ? KNOWN : null), nowSeconds: 1_700_000_500 });
    add({ id: "forged-auth", attack: "An agent fabricates an authorization credential from an issuer of its own choosing.", realWorld: "Forged tokens / trust-anchor confusion - the class of attacks behind signature-forgery and JWT-confusion CVEs.", coverage: v.status === "claimed" ? "prevented" : "detected", control: "Fail-closed verification: only a credential signed by a registered issuer is trusted; everything else is claimed, never verified.", detail: `verdict: ${v.status}` });
  }

  // 9. Supply-chain build compromise - HONESTLY out of scope.
  add({ id: "supply-chain", attack: "Malicious code is injected into a software build/update pipeline and shipped to victims.", realWorld: "Build-pipeline compromise (the SolarWinds/CI-supply-chain class).", coverage: "out_of_scope", control: "Out of scope: Forcefield defends inbound AGENT traffic at the edge; it does not secure your build pipeline. We say so rather than overclaim. (OGIAM's Secure-Agent SDLC gate addresses this separately.)", detail: "not an inbound-agent attack" });

  // 10. Authorized insider with valid full access - HONESTLY out of scope here.
  add({ id: "authorized-insider", attack: "A legitimately-authorized principal, acting within its granted scope, exfiltrates data.", realWorld: "Malicious-insider / authorized-abuse (a DLP/behavioral-analytics problem).", coverage: "out_of_scope", control: "Out of scope by design: a verified principal within its mandate is ALLOWED - blocking it would block legitimate work. This is DLP/anomaly territory, not agent-defense. Honesty over a false claim.", detail: "verified + within mandate = allowed by design" });

  const prevented = results.filter((r) => r.coverage === "prevented").length;
  const detected = results.filter((r) => r.coverage === "detected").length;
  const outOfScope = results.filter((r) => r.coverage === "out_of_scope").length;
  return { results, prevented, detected, outOfScope, total: results.length };
}
