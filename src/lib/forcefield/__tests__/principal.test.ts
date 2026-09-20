/**
 * The honesty rail is the whole feature: a credential is "verified" ONLY on a
 * clean cryptographic check against a registered issuer; everything else is
 * "claimed", never "verified". And mandate_exceeded (verified-but-out-of-scope)
 * is the strongest hostile signal. DB is not touched (resolveIssuer injected).
 */
import { delegationSignature } from "@/lib/ogiam/delegate";
import {
  verifyPresentedDelegation,
  parseDelegation,
  checkMandate,
  scopeMatches,
  type DelegationIssuer,
  type PrincipalVerdict,
} from "@/lib/forcefield/principal";

const SECRET = "issuer-secret-key-abc";
const ISSUER: DelegationIssuer = { issuer: "acme-fleet", algorithm: "hs256", secret: SECRET, allowedScopes: [] };
const NOW = 1_700_000_000; // fixed epoch seconds

/** Mint a compact credential the way an honest issuer would, reusing OGIAM's
 *  own signature construction so the test proves cross-side agreement. */
function mint(body: Record<string, unknown>, opts?: { secret?: string; timestamp?: number }): string {
  const json = JSON.stringify(body);
  const b64 = Buffer.from(json, "utf8").toString("base64url");
  const ts = opts?.timestamp ?? NOW;
  const sig = delegationSignature(opts?.secret ?? SECRET, json, ts);
  return `${b64}.${ts}.${sig}`;
}
const resolve = (i: string) => (i === ISSUER.issuer ? ISSUER : null);
const verify = (raw: string | null | undefined, audience?: string) =>
  verifyPresentedDelegation(raw, { resolveIssuer: resolve, nowSeconds: NOW, audience });

describe("verifyPresentedDelegation - fail-closed honesty rail", () => {
  it("verifies a well-formed, correctly-signed, unexpired credential", async () => {
    const v = await verify(mint({ principal: "person:42", issuer: "acme-fleet", scopes: ["/catalog"], exp: NOW + 60 }));
    expect(v.status).toBe("verified");
    expect(v.principal).toBe("person:42");
    expect(v.issuer).toBe("acme-fleet");
    expect(v.scopes).toEqual(["/catalog"]);
  });

  it("returns absent when no credential is presented", async () => {
    for (const raw of [null, undefined, ""]) {
      expect((await verify(raw)).status).toBe("absent");
    }
  });

  it("claims (never verifies) a malformed credential", async () => {
    for (const raw of ["not-a-credential", "a.b", "a.b.c.d", "!!.123.sig"]) {
      const v = await verify(raw);
      expect(v.status).toBe("claimed");
    }
  });

  it("claims a credential from an UNREGISTERED issuer", async () => {
    const v = await verify(mint({ principal: "p", issuer: "stranger", scopes: ["/"] }));
    expect(v.status).toBe("claimed");
    expect(v.reason).toMatch(/not a registered/i);
    expect(v.scopes).toEqual([]); // no scopes trusted from an unverified credential
  });

  it("claims a credential whose signature was forged (wrong secret)", async () => {
    const v = await verify(mint({ principal: "p", issuer: "acme-fleet", scopes: ["/"] }, { secret: "wrong" }));
    expect(v.status).toBe("claimed");
    expect(v.reason).toMatch(/signature/i);
  });

  it("claims a credential whose body was tampered after signing", async () => {
    const good = mint({ principal: "p", issuer: "acme-fleet", scopes: ["/catalog"], exp: NOW + 60 });
    const [, ts, sig] = good.split(".");
    const tampered = Buffer.from(JSON.stringify({ principal: "p", issuer: "acme-fleet", scopes: ["/admin"] }), "utf8").toString("base64url");
    expect((await verify(`${tampered}.${ts}.${sig}`)).status).toBe("claimed");
  });

  it("claims an expired credential", async () => {
    const v = await verify(mint({ principal: "p", issuer: "acme-fleet", scopes: ["/"], exp: NOW - 1 }));
    expect(v.status).toBe("claimed");
    expect(v.reason).toMatch(/expired/i);
  });

  it("claims on audience mismatch when we require one", async () => {
    const v = await verify(mint({ principal: "p", issuer: "acme-fleet", scopes: ["/"], audience: "other.example" }), "ogiam.com");
    expect(v.status).toBe("claimed");
    expect(v.reason).toMatch(/audience/i);
  });

  it("intersects presented scopes with an issuer's allowed_scopes cap", async () => {
    const capped: DelegationIssuer = { ...ISSUER, allowedScopes: ["/catalog"] };
    const v = await verifyPresentedDelegation(
      mint({ principal: "p", issuer: "acme-fleet", scopes: ["/catalog", "/admin"], exp: NOW + 60 }),
      { resolveIssuer: (i) => (i === "acme-fleet" ? capped : null), nowSeconds: NOW },
    );
    expect(v.status).toBe("verified");
    expect(v.scopes).toEqual(["/catalog"]); // /admin stripped: issuer may never grant it
  });
});

describe("parseDelegation", () => {
  it("round-trips the compact wire form", () => {
    const p = parseDelegation(mint({ principal: "p", issuer: "acme-fleet", scopes: ["/x"] }));
    expect(p?.body.principal).toBe("p");
    expect(p?.body.scopes).toEqual(["/x"]);
  });
  it("rejects oversized input", () => {
    expect(parseDelegation("x".repeat(9000))).toBeNull();
  });
});

describe("scopeMatches", () => {
  it.each([
    ["/catalog", "/catalog", true],
    ["/catalog", "/catalog/item/9", true],
    ["/catalog", "/catalogs", false], // prefix must respect segment boundary
    ["/api/*", "/api/products", true],
    ["*", "/anything", true],
    ["/admin", "/catalog", false],
  ])("scope %s vs path %s -> %s", (scope, path, expected) => {
    expect(scopeMatches(scope, path)).toBe(expected);
  });
});

describe("checkMandate - behavior vs the presented mandate", () => {
  const verified = (scopes: string[]): PrincipalVerdict => ({ status: "verified", principal: "p", issuer: "acme-fleet", scopes, reason: "ok" });

  it("within scope when every path is authorized", () => {
    const m = checkMandate(verified(["/catalog", "/api/*"]), ["/catalog", "/api/products", "/catalog/9"]);
    expect(m.withinScope).toBe(true);
    expect(m.violations).toEqual([]);
  });

  it("flags mandate_exceeded when the agent stepped outside its grant", () => {
    const m = checkMandate(verified(["/catalog"]), ["/catalog", "/admin", "/.env"]);
    expect(m.withinScope).toBe(false);
    expect(m.violations).toEqual(["/admin", "/.env"]);
  });

  it("a claimed or absent principal has no proven mandate to exceed", () => {
    expect(checkMandate({ status: "claimed", scopes: [], reason: "x" }, ["/admin"]).withinScope).toBe(true);
    expect(checkMandate({ status: "absent", scopes: [], reason: "x" }, ["/admin"]).withinScope).toBe(true);
  });
});
