/**
 * Self-attack harness - spoof the attack before a real one shows up. Each
 * scenario drives an adversarial input through the REAL, deterministic defense
 * functions (not a mock of them) and asserts the defense responded correctly.
 * The point of the org thesis made literal: every control we claim has a
 * standing adversarial test that proves it holds, and would fail loudly if a
 * change ever reopened the hole.
 *
 * Deterministic + server-side (it drives verifyPresentedDelegation, which needs
 * the crypto layer). The route runs it and the UI renders the verdicts; the UI
 * never imports this module.
 *
 * A scenario's `defended` is what MUST be true for the control to hold. The
 * famous-breach corpus plugs in here as more scenarios.
 */
import { qualifiesForAutoBlock, decideEdgeAction, type EdgeSignals } from "@/lib/forcefield/edge-enforcement";
import { checkMandate, type PrincipalVerdict } from "@/lib/forcefield/principal-types";
import { verifyPresentedDelegation, type DelegationIssuer } from "@/lib/forcefield/principal";
import { delegationSignature } from "@/lib/ogiam/delegate";

export interface ScenarioResult {
  id: string;
  /** The attack, in plain language. */
  attack: string;
  /** The control that is supposed to stop it. */
  control: string;
  /** True when the defense responded as it must. */
  defended: boolean;
  /** What the defense actually did. */
  detail: string;
}

export interface AdversarialReport {
  results: ScenarioResult[];
  defendedCount: number;
  total: number;
  /** True only when every scenario is defended. */
  allDefended: boolean;
}

const NOW = 1_800_000_000;
const ISSUER_SECRET = "self-test-issuer-secret-key";
const KNOWN_ISSUER: DelegationIssuer = { issuer: "known", algorithm: "hs256", secret: ISSUER_SECRET, allowedScopes: [] };
const resolveKnown = (i: string) => (i === "known" ? KNOWN_ISSUER : null);

function mint(body: Record<string, unknown>, secret = ISSUER_SECRET, ts = NOW): string {
  const json = JSON.stringify(body);
  return `${Buffer.from(json, "utf8").toString("base64url")}.${ts}.${delegationSignature(secret, json, ts)}`;
}
const baseSignals = (p: Partial<EdgeSignals> = {}): EdgeSignals => ({
  blocked: false, trustBand: "caution", mandateExceeded: false, principalStatus: "absent", networkHostile: false, ...p,
});

/** Every scenario returns its verdict from the REAL defense functions. */
export async function runAdversarialSuite(): Promise<AdversarialReport> {
  const results: ScenarioResult[] = [];
  const record = (id: string, attack: string, control: string, defended: boolean, detail: string) =>
    results.push({ id, attack, control, defended, detail });

  // 1. Forged principal: a delegation from an issuer we never registered.
  {
    const v = await verifyPresentedDelegation(mint({ principal: "attacker", issuer: "stranger", scopes: ["/admin"], jti: "a1", exp: NOW + 60 }), { resolveIssuer: resolveKnown, nowSeconds: NOW });
    record("forged-principal", "An agent presents a delegation from an issuer we never trusted, claiming to be authorized.", "Know the Principal (fail-closed verification)", v.status === "claimed", `verdict: ${v.status}`);
  }

  // 2. Tampered credential: body changed after signing.
  {
    const good = mint({ principal: "p", issuer: "known", scopes: ["/catalog"], jti: "a2", exp: NOW + 60 });
    const [, ts, sig] = good.split(".");
    const tampered = Buffer.from(JSON.stringify({ principal: "p", issuer: "known", scopes: ["/admin"], jti: "a2" }), "utf8").toString("base64url");
    const v = await verifyPresentedDelegation(`${tampered}.${ts}.${sig}`, { resolveIssuer: resolveKnown, nowSeconds: NOW });
    record("tampered-credential", "An agent edits its delegation to widen scope, keeping the old signature.", "Signature verification", v.status === "claimed", `verdict: ${v.status}`);
  }

  // 3. Replay: the same valid credential presented twice.
  {
    const raw = mint({ principal: "p", issuer: "known", scopes: ["/catalog"], jti: "replay-1", exp: NOW + 60 });
    const seen = new Set<string>();
    const consumeJti = async (jti: string) => { if (seen.has(jti)) return false; seen.add(jti); return true; };
    const first = await verifyPresentedDelegation(raw, { resolveIssuer: resolveKnown, nowSeconds: NOW, consumeJti });
    const second = await verifyPresentedDelegation(raw, { resolveIssuer: resolveKnown, nowSeconds: NOW, consumeJti });
    record("replay", "An agent captures a valid delegation and replays it.", "Replay defense (jti)", first.status === "verified" && second.status === "claimed", `first: ${first.status}, replay: ${second.status}`);
  }

  // 4. Mandate abuse: a verified principal steps outside its granted scope.
  {
    const verdict: PrincipalVerdict = { status: "verified", principal: "p", issuer: "known", scopes: ["/catalog"], reason: "ok" };
    const m = checkMandate(verdict, ["/catalog", "/admin", "/.env"]);
    record("mandate-abuse", "A verified agent uses its access to probe paths outside its mandate.", "Mandate conformance", !m.withinScope && m.violations.includes("/admin"), `violations: ${m.violations.join(", ") || "none"}`);
  }

  // 5. Auto-block DOES fire on a proven-hostile actor.
  {
    const q = qualifiesForAutoBlock(baseSignals({ trustBand: "hostile" }), { proven: true });
    record("auto-block-fires", "A proven-hostile agent keeps attacking, expecting to stay online.", "Auto-block (proven)", q.auto, `auto: ${q.auto}`);
  }

  // 6. Auto-block does NOT fire on an inferred grouping (protect the client).
  {
    const q = qualifiesForAutoBlock(baseSignals({ trustBand: "hostile" }), { proven: false });
    record("auto-block-spares-client", "A hostile-looking but only INFERRED actor risks being confused with a real customer.", "Auto-block safety rail (proven-only)", q.auto === false, `auto: ${q.auto} (${q.reason})`);
  }

  // 7. Good bot is not blocked.
  {
    const d = decideEdgeAction(baseSignals({ trustBand: "trusted", principalStatus: "verified" }), { mode: "enforce" });
    const q = qualifiesForAutoBlock(baseSignals({ trustBand: "trusted", principalStatus: "verified" }), { proven: true });
    record("good-bot-spared", "A verified, rule-respecting good bot must never be blocked.", "Trust-aware enforcement", d.intended === "allow" && q.auto === false, `edge: ${d.intended}, auto: ${q.auto}`);
  }

  // 8. Blocklisted operator is stopped outright.
  {
    const d = decideEdgeAction(baseSignals({ blocked: true, trustBand: "trusted" }), { mode: "enforce" });
    record("blocklist-enforced", "An operator a human already blocked tries again from a fresh session.", "Blocklist enforcement", d.intended === "block" && d.ruleId === "operator_blocklisted", `edge: ${d.intended} (${d.ruleId})`);
  }

  // 9. Reputation poisoning: a hostile workspace floods a network signal against a
  //    legitimate operator, hoping to force a block elsewhere.
  {
    const decision = decideEdgeAction(baseSignals({ networkHostile: true, trustBand: "caution" }), { mode: "enforce" });
    const auto = qualifiesForAutoBlock(baseSignals({ networkHostile: true, trustBand: "caution" }), { proven: true }).auto;
    record("reputation-poisoning", "A hostile workspace floods the reputation network against a legitimate operator to force a wrongful block.", "Sybil resistance (network challenges, never hard-blocks alone; corroboration required)", decision.intended === "challenge" && auto === false, `edge: ${decision.intended}, auto-block: ${auto}`);
  }

  const defendedCount = results.filter((r) => r.defended).length;
  return { results, defendedCount, total: results.length, allDefended: defendedCount === results.length };
}
