/**
 * Security-posture parity: the public page may only claim "In place" for a
 * control whose evidence check does not read gap.
 *
 *  1. The page's Control status table and the claim registry agree, row for row.
 *  2. For every "In place" claim, a fixture with gap evidence FAILS the check.
 *  3. Against the state measured read-only in production on 2026-10-24, the
 *     page as written has zero violations.
 *  4. The audit's known false claims are not on the page.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  POSTURE_CLAIMS,
  checkPostureParity,
  parseDocClaims,
  type PostureFacts,
} from "../posture-claims";
import { guardrailFromBaseline, ATTESTED } from "../posture-evidence";
import type { PlatformEvidence } from "../platform-evidence";
import type { EvidenceProbe } from "../evidence-window";

const DOC = readFileSync(join(process.cwd(), "docs", "security-posture.md"), "utf8");

const probe = (state: EvidenceProbe["state"]): EvidenceProbe => ({
  key: "k", proof: "p", windowDays: 7, count: state === "fresh" ? 1 : 0, lastAt: state === "none" || state === "error" ? null : "2026-10-23T00:00:00.000Z", state,
});

const HEALTHY_PLATFORM: PlatformEvidence = {
  oauthTokens: { total: 6, plaintext: 0 },
  connectorCredentials: { total: 4, plaintext: 0 },
  rls: { tables: 248, rlsEnabled: 248, forced: 248, policies: 248, nonTrivialPolicies: 248, roleBypassesRls: false, ownedByRole: 0 },
  gate: { windowDays: 30, decisions: 100, enforced: 50, enforcedBlocks: 5, enforcedEscalations: 2, wouldBlock: 5 },
  signedCheckpoints: probe("fresh"),
  kekSource: "dedicated",
};

const HEALTHY: PostureFacts = {
  platform: HEALTHY_PLATFORM,
  chain: probe("fresh"),
  isolationGuardrail: true,
  hybridTlsAssertedInCi: true,
  accessTokenTtlSeconds: 900,
  mfaEnforced: true,
  codeqlRequired: true,
};

/** The shape measured read-only against production on 2026-10-24 (counts
 *  generalized): plaintext OAuth tokens, connector ciphertext under a non-
 *  dedicated key, permissive unforced RLS with a bypassing owner role, no signed
 *  checkpoint, a fresh passing chain verification, PROD_DOMAIN unset. */
const MEASURED: PostureFacts = {
  platform: {
    oauthTokens: { total: 5, plaintext: 5 },
    connectorCredentials: { total: 3, plaintext: 0 },
    rls: { tables: 200, rlsEnabled: 30, forced: 0, policies: 30, nonTrivialPolicies: 0, roleBypassesRls: true, ownedByRole: 200 },
    gate: { windowDays: 30, decisions: 1000, enforced: 20, enforcedBlocks: 0, enforcedEscalations: 0, wouldBlock: 10 },
    signedCheckpoints: probe("none"),
    kekSource: "derived-from-jwt",
  },
  chain: probe("fresh"),
  isolationGuardrail: guardrailFromBaseline(),
  hybridTlsAssertedInCi: false,
  accessTokenTtlSeconds: 900,
  mfaEnforced: ATTESTED.mfaEnforced,
  codeqlRequired: ATTESTED.codeqlRequired,
};

describe("the page and the claim registry agree", () => {
  const rows = parseDocClaims(DOC);

  it("the Control status table parses", () => {
    expect(rows.length).toBeGreaterThanOrEqual(POSTURE_CLAIMS.length);
  });

  it.each(POSTURE_CLAIMS.map((c) => [c.key, c] as const))("%s is on the page with the registry's status", (key, claim) => {
    const row = rows.find((r) => r.key === key);
    expect(row).toBeDefined();
    expect(row!.status).toBe(claim.docStatus);
  });

  it("every row on the page has an evidence check (no claim without evidence)", () => {
    for (const r of rows) expect(POSTURE_CLAIMS.map((c) => c.key)).toContain(r.key);
  });

  it("keys are unique and every claim states its proof", () => {
    const keys = POSTURE_CLAIMS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const c of POSTURE_CLAIMS) expect(c.proof.length).toBeGreaterThan(15);
  });
});

describe("parity: an In place claim with gap evidence fails", () => {
  it("the healthy fixture has no violations", () => {
    expect(checkPostureParity(HEALTHY).violations).toBe(0);
  });

  const gapFor: Record<string, Partial<PostureFacts>> = {
    "tls.hybrid_kex": {}, // unmeasurable in-app: unknown, never a pass on its own
    "isolation.app_predicate": { isolationGuardrail: false },
    "auth.short_access_tokens": { accessTokenTtlSeconds: 8 * 3600 },
    "audit.hash_chain": { chain: probe("stale") },
  };

  it("every In place claim has a gap fixture here", () => {
    const inPlace = POSTURE_CLAIMS.filter((c) => c.docStatus === "in_place").map((c) => c.key).sort();
    expect(Object.keys(gapFor).sort()).toEqual(inPlace);
  });

  it.each(Object.entries(gapFor).filter(([k]) => k !== "tls.hybrid_kex"))("%s: gap evidence is a violation", (key, over) => {
    const r = checkPostureParity({ ...HEALTHY, ...over }).results.find((x) => x.key === key)!;
    expect(r.evidence).toBe("gap");
    expect(r.violation).toBe(true);
  });

  it("tls.hybrid_kex without the CI assertion reads unknown, not proven", () => {
    const r = checkPostureParity({ ...HEALTHY, hybridTlsAssertedInCi: false }).results.find((x) => x.key === "tls.hybrid_kex")!;
    expect(r.evidence).toBe("unknown");
  });

  it("flipping a Not in place claim to In place while its evidence is gap is caught", () => {
    const lying = POSTURE_CLAIMS.map((c) => (c.key === "isolation.db_rls" || c.key === "secrets.oauth_tokens_encrypted" ? { ...c, docStatus: "in_place" as const } : c));
    const r = checkPostureParity(MEASURED, lying);
    expect(r.results.filter((x) => x.violation).map((x) => x.key).sort()).toEqual(["isolation.db_rls", "secrets.oauth_tokens_encrypted"]);
  });

  it("a non-dedicated key is not encryption under a dedicated key", () => {
    const facts = { ...HEALTHY, platform: { ...HEALTHY_PLATFORM, kekSource: "dev-literal" as const } };
    expect(checkPostureParity(facts).results.find((x) => x.key === "secrets.app_encrypted")!.evidence).toBe("gap");
  });

  it("unmeasured facts are unknown, never proven", () => {
    const r = checkPostureParity({ ...HEALTHY, platform: null, chain: null, isolationGuardrail: null });
    for (const k of ["secrets.oauth_tokens_encrypted", "secrets.app_encrypted", "isolation.db_rls", "audit.hash_chain", "signing.ledger_checkpoints", "isolation.app_predicate"]) {
      expect(r.results.find((x) => x.key === k)!.evidence).toBe("unknown");
    }
  });

  it("an evaluator that throws reads unknown", () => {
    const r = checkPostureParity(HEALTHY, [{ ...POSTURE_CLAIMS[0], evaluate: () => { throw new Error("x"); } }]);
    expect(r.results[0].evidence).toBe("unknown");
  });
});

describe("the page as written against the measured production state", () => {
  const r = checkPostureParity(MEASURED);
  it("has zero violations", () => {
    expect(r.results.filter((x) => x.violation)).toEqual([]);
  });
  it("the known-false claims are recorded as not done", () => {
    const by = Object.fromEntries(r.results.map((x) => [x.key, x]));
    expect(by["secrets.oauth_tokens_encrypted"].docStatus).toBe("in_progress");
    expect(by["isolation.db_rls"].docStatus).toBe("not_in_place");
    expect(by["auth.mfa_enforced"].docStatus).toBe("not_in_place");
    expect(by["ci.codeql_required"].docStatus).toBe("not_in_place");
  });
});

describe("the audit's false claims are gone from the page", () => {
  it.each([
    [/OAuth refresh tokens[^.]*encrypted by the application/i, "OAuth tokens claimed encrypted"],
    [/compliance evidence[^|.]*encrypted by the application/i, "compliance evidence claimed app-encrypted"],
    [/RLS-scoped|row-level security enforces/i, "RLS claimed to enforce isolation"],
    [/MFA (is )?(enforced|required) for (all )?admin/i, "MFA claimed enforced"],
    [/CodeQL[^.|]*fails the build/i, "CodeQL claimed to fail the build (outside the Not in place row)"],
  ])("%s (%s)", (re) => {
    const outsideTable = DOC.split("## Control status")[0] + (DOC.split("## Current Crypto Inventory")[1] ?? "");
    expect(outsideTable).not.toMatch(re);
  });
});
