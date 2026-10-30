/** @jest-environment node */
/**
 * Web Bot Auth verification against PUBLISHED vectors, so the verifier agrees with
 * real agents and other implementations, not only with itself:
 *   - RFC 9421 Appendix B.1.4 (test-key-ed25519) and B.2.6 (an Ed25519 signature
 *     over a POST with header components)
 *   - draft-meunier-web-bot-auth-architecture Appendix A.2.1 (no Signature-Agent),
 *     A.2.2 (Signature-Agent as a dictionary) and A.2.3 (legacy string form)
 * Every tampering case below must turn a verified vector into "invalid".
 */
import {
  _resetDirectoryCache,
  DIRECTORY_PATH,
  directoryKeys,
  jwkThumbprint,
  parseDictionary,
  signatureBase,
  verifyAgentSignature,
  WBA_ALGORITHMS,
  type FetchLike,
  type SignedRequest,
} from "@/lib/forcefield-web/web-bot-auth";

const TEST_KEY = { kty: "OKP", crv: "Ed25519", x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs" };
const KEYID = "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";
const NOW_2025 = Date.UTC(2025, 0, 1, 0, 10); // within every vector's created/expires window

const req = (headers: Record<string, string>, url = "https://example.com/foo?param=Value&Pet=dog", method = "POST"): SignedRequest => {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { method, url, header: (n) => h.get(n.toLowerCase()) ?? null };
};

const A21 = {
  "signature-input": `sig1=("@authority");created=1735689600;keyid="${KEYID}";alg="ed25519";expires=4889289600;nonce="g0iqFa9e1ffijlyOScDkXpfSmTbYpRNSGPJrQ1It20ahwgzB3jOUcdgLgFxUg7RMtW4V8IILaKKtA+YuSyIgJQ==";tag="web-bot-auth"`,
  signature: "sig1=:FFASViSdcgsyaqqYiCnkHreeZzbNKcTzDvZC5uVlP/dn9IbWj8j0o4wKFTH3rBnUiSUBduwm1Gp5VlIPCp01Ag==:",
};
const A22 = {
  "signature-agent": 'agent2="https://signature-agent.test"',
  "signature-input": `sig2=("@authority" "signature-agent";key="agent2");created=1735689600;keyid="${KEYID}";alg="ed25519";expires=4889289600;nonce="XeP72svPKNiGEg3aDE7WJuTpN69H08oMFqC8NLFy1MptpENAT3WZTYwK+MYdsFMlaqHCJGo9ZAhqer1NWY9Epg==";tag="web-bot-auth"`,
  signature: "sig2=:DGiW2ErlQh0hc8wY2FQdbnFd6CEmonyY8nlvECIJFaUSYYNvNvSsGyP99BUGtq51gA4ouXlkUwjnta084bpjCg==:",
};
const A23 = {
  "signature-agent": '"https://signature-agent.test"',
  "signature-input": `sig2=("@authority" "signature-agent");created=1735689600;keyid="${KEYID}";alg="ed25519";expires=1735693200;nonce="e8N7S2MFd/qrd6T2R3tdfAuuANngKI7LFtKYI/vowzk4lAZYadIX6wW25MwG7DCT9RUKAJ0qVkU0mEeLElW1qg==";tag="web-bot-auth"`,
  signature: "sig2=:jdq0SqOwHdyHr9+r5jw3iYZH6aNGKijYp/EstF4RQTQdi5N5YYKrD+mCT1HA1nZDsi6nJKuHxUi/5Syp3rLWBA==:",
};

/** A directory host for signature-agent.test that serves the RFC test key. */
function directory(keysBody: unknown = { keys: [TEST_KEY] }) {
  const calls: string[] = [];
  const f: FetchLike = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify(keysBody) };
  };
  return { f, calls };
}
const AGENTS = ["https://signature-agent.test"];

beforeEach(() => _resetDirectoryCache());

describe("RFC 9421 vectors", () => {
  it("B.1.4: the test key's JWK thumbprint is the Web Bot Auth keyid", async () => {
    expect(await jwkThumbprint(TEST_KEY)).toBe(KEYID);
  });

  it("B.2.6: the signature base is built exactly and the published signature verifies", async () => {
    const r = req({
      date: "Tue, 20 Apr 2021 02:07:55 GMT",
      "content-type": "application/json",
      "content-length": "18",
    });
    const input = parseDictionary(`sig-b26=("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"`).get("sig-b26");
    const base = signatureBase(r, input as never);
    expect(base).toBe(
      [
        '"date": Tue, 20 Apr 2021 02:07:55 GMT',
        '"@method": POST',
        '"@path": /foo',
        '"@authority": example.com',
        '"content-type": application/json',
        '"content-length": 18',
        '"@signature-params": ("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"',
      ].join("\n"),
    );
    const sig = Uint8Array.from(atob("wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw=="), (c) => c.charCodeAt(0));
    expect(await WBA_ALGORITHMS.ed25519!(TEST_KEY, sig, new TextEncoder().encode(base))).toBe(true);
  });
});

describe("Web Bot Auth draft vectors (A.2)", () => {
  it("A.2.1 (no Signature-Agent): verified with the key supplied", async () => {
    expect(await verifyAgentSignature(req(A21), { keys: [TEST_KEY], nowMs: NOW_2025 })).toMatchObject({ verdict: "verified" });
  });

  it("A.2.2 (Signature-Agent dictionary): the key is fetched from the agent's directory, matched by thumbprint", async () => {
    const d = directory();
    const r = await verifyAgentSignature(req(A22), { agents: AGENTS, fetchImpl: d.f, nowMs: NOW_2025 });
    // The draft's A.2.2 signature verifies over the member WITHOUT quotes (its displayed
    // base shows them): recorded as the bare form, so the gap stays visible.
    expect(r).toEqual({ verdict: "verified", reason: "signature_verified_bare_member", agent: "signature-agent.test" });
    expect(d.calls).toEqual([`https://signature-agent.test${DIRECTORY_PATH}`]);
  });

  it("A.2.3 (legacy Signature-Agent string) inside its one-hour window", async () => {
    const d = directory();
    expect(await verifyAgentSignature(req(A23), { agents: AGENTS, fetchImpl: d.f, nowMs: NOW_2025 })).toMatchObject({ verdict: "verified" });
  });

  it("the draft's single-key directory shape ({ keys: {...} }) is read too", async () => {
    expect(directoryKeys({ keys: TEST_KEY })).toEqual([TEST_KEY]);
    const d = directory({ keys: TEST_KEY });
    expect(await verifyAgentSignature(req(A22), { agents: AGENTS, fetchImpl: d.f, nowMs: NOW_2025 })).toMatchObject({ verdict: "verified" });
  });

  it("the directory is fetched once per origin, then cached", async () => {
    const d = directory();
    await verifyAgentSignature(req(A22), { agents: AGENTS, fetchImpl: d.f, nowMs: NOW_2025 });
    await verifyAgentSignature(req(A22), { agents: AGENTS, fetchImpl: d.f, nowMs: NOW_2025 + 1000 });
    expect(d.calls).toHaveLength(1);
  });
});

describe("tampering and replay are invalid", () => {
  const verify = (h: Record<string, string>, url?: string, nowMs = NOW_2025) =>
    verifyAgentSignature(req(h, url), { agents: AGENTS, fetchImpl: directory().f, nowMs });

  it("a different authority (the signature was made for another site)", async () => {
    expect(await verify(A22, "https://weekendwithporsche.com/")).toMatchObject({ verdict: "invalid", reason: "bad_signature" });
  });
  it("one flipped byte of the signature", async () => {
    expect(await verify({ ...A22, signature: A22.signature.replace("DGiW", "DGiX") })).toMatchObject({ verdict: "invalid", reason: "bad_signature" });
  });
  it("an edited parameter (nonce)", async () => {
    expect(await verify({ ...A22, "signature-input": A22["signature-input"].replace("XeP72", "XeP73") })).toMatchObject({ verdict: "invalid" });
  });
  it("a swapped Signature-Agent value", async () => {
    expect(await verify({ ...A22, "signature-agent": 'agent2="https://evil.test"' })).toMatchObject({ verdict: "unverifiable", reason: "agent_not_listed" });
  });
  it("expired (A.2.3 replayed after its hour)", async () => {
    expect(await verify(A23, undefined, Date.UTC(2025, 0, 1, 2))).toMatchObject({ verdict: "invalid", reason: "expired" });
  });
  it("created in the future", async () => {
    expect(await verify(A22, undefined, Date.UTC(2024, 11, 31))).toMatchObject({ verdict: "invalid", reason: "created_in_future" });
  });
  it("a keyid the directory does not hold", async () => {
    const other = { ...A22, "signature-input": A22["signature-input"].replace(KEYID, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") };
    expect(await verify(other)).toMatchObject({ verdict: "invalid", reason: "keyid_not_in_directory" });
  });
  it("Signature-Agent sent but not covered by the signature", async () => {
    expect(await verify({ ...A21, "signature-agent": 'a="https://signature-agent.test"' })).toMatchObject({ verdict: "invalid", reason: "signature_agent_not_covered" });
  });
  it("no web-bot-auth tag, or garbage headers", async () => {
    expect(await verify({ ...A22, "signature-input": A22["signature-input"].replace('tag="web-bot-auth"', 'tag="other"') })).toMatchObject({ verdict: "invalid", reason: "no_web_bot_auth_signature" });
    expect(await verify({ "signature-input": "((((", signature: "x" })).toMatchObject({ verdict: "invalid", reason: "malformed_signature_headers" });
  });
});

describe("unverifiable, never guessed", () => {
  it("an agent not on the list is never fetched", async () => {
    const d = directory();
    expect(await verifyAgentSignature(req(A22), { agents: [], fetchImpl: d.f, nowMs: NOW_2025 })).toMatchObject({ verdict: "unverifiable", reason: "agent_not_listed" });
    expect(d.calls).toHaveLength(0);
  });
  it("an unreachable directory", async () => {
    const f: FetchLike = async () => ({ ok: false, status: 503, text: async () => "" });
    expect(await verifyAgentSignature(req(A22), { agents: AGENTS, fetchImpl: f, nowMs: NOW_2025 })).toMatchObject({ verdict: "unverifiable", reason: "directory_unreachable" });
  });
  it("a reserved algorithm (RSA-PSS, ML-DSA) until it is implemented", async () => {
    const rsa = { ...A22, "signature-input": A22["signature-input"].replace('alg="ed25519"', 'alg="rsa-pss-sha512"') };
    expect(await verifyAgentSignature(req(rsa), { agents: AGENTS, fetchImpl: directory().f, nowMs: NOW_2025 })).toMatchObject({ verdict: "unverifiable", reason: "algorithm_not_supported:rsa-pss-sha512" });
  });
  it("an http:// agent origin is refused", async () => {
    const h = { ...A22, "signature-agent": 'agent2="http://signature-agent.test"' };
    expect(await verifyAgentSignature(req(h), { agents: ["http://signature-agent.test"], fetchImpl: directory().f, nowMs: NOW_2025 })).toMatchObject({ verdict: "invalid", reason: "signature_agent_not_https" });
  });
});
