/**
 * Know the Principal, wired through the behavior classifier + trust score.
 * A verified principal that stayed in-scope is the strongest GOOD tell; one that
 * stepped outside its granted mandate (mandate_exceeded) is the strongest HOSTILE
 * tell - an authorized agent abusing its grant. A claimed (unverifiable)
 * credential is a red flag on its own.
 */
import { classifySession, type SessionEvent } from "@/lib/agent-behavior";
import { buildAgentProfile } from "@/lib/agent-profile";
import { consolidateByOperator, deriveTrustProfile } from "@/lib/agent-operators-view";

let seq = 0;
function ev(path: string, extra: Partial<SessionEvent> = {}): SessionEvent {
  seq += 1;
  return { type: "site.page_viewed", path, at: `2026-09-19T10:00:${String(seq).padStart(2, "0")}Z`, ...extra };
}
function classify(events: SessionEvent[], key = "op-key") {
  return classifySession({ key, keyKind: "fingerprint", events });
}
function trustFor(events: SessionEvent[]) {
  const j = { ...classify(events), profile: buildAgentProfile(classify(events)) };
  const [group] = consolidateByOperator([j as never]);
  return { trust: deriveTrustProfile(group), journey: j };
}
const principalProps = (status: "verified" | "claimed", scopes: string[] = []) => ({
  principalStatus: status,
  principal: "person:42",
  principalIssuer: "acme-fleet",
  principalScopes: scopes,
});

describe("classifySession - principal reasoning", () => {
  it("emits principal_verified when a verified principal stayed in scope", () => {
    const j = classify([ev("/catalog", principalProps("verified", ["/catalog"])), ev("/catalog/9")]);
    expect(j.principal?.status).toBe("verified");
    expect(j.mandate?.withinScope).toBe(true);
    expect(j.insights.map((i) => i.kind)).toContain("principal_verified");
  });

  it("emits mandate_exceeded when a verified principal stepped outside its grant", () => {
    const j = classify([ev("/catalog", principalProps("verified", ["/catalog"])), ev("/admin"), ev("/.env")]);
    expect(j.mandate?.withinScope).toBe(false);
    const mandate = j.insights.find((i) => i.kind === "mandate_exceeded");
    expect(mandate).toBeTruthy();
    expect((mandate as { violations: string[] }).violations).toEqual(expect.arrayContaining(["/admin", "/.env"]));
  });

  it("emits principal_unverifiable for a claimed (unverifiable) credential", () => {
    const j = classify([ev("/x", principalProps("claimed"))]);
    expect(j.principal?.status).toBe("claimed");
    expect(j.insights.map((i) => i.kind)).toContain("principal_unverifiable");
  });

  it("stays silent (absent) when no delegation was presented", () => {
    const j = classify([ev("/about"), ev("/pricing")]);
    expect(j.principal?.status).toBe("absent");
    expect(j.insights.map((i) => i.kind)).not.toContain("principal_verified");
  });
});

describe("deriveTrustProfile - principal moves the score + intent", () => {
  it("a verified in-scope principal raises trust and reads as authorized delegation", () => {
    const clean = trustFor([ev("/about")]).trust.score;
    const { trust } = trustFor([ev("/catalog", principalProps("verified", ["/catalog"]))]);
    expect(trust.score).toBeGreaterThan(clean);
    expect(trust.intent).toBe("authorized_delegation");
  });

  it("mandate_exceeded is the strongest hostile intent and tanks the score", () => {
    const { trust } = trustFor([ev("/catalog", principalProps("verified", ["/catalog"])), ev("/admin"), ev("/wp-login.php")]);
    expect(trust.intent).toBe("mandate_violation");
    expect(trust.score).toBeLessThan(50);
    expect(trust.band === "untrusted" || trust.band === "hostile").toBe(true);
  });

  it("a claimed credential lowers trust vs an anonymous visit", () => {
    const anon = trustFor([ev("/about")]).trust.score;
    const { trust } = trustFor([ev("/about2", principalProps("claimed"))]);
    expect(trust.score).toBeLessThan(anon);
  });
});
