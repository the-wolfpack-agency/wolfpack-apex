/**
 * Forcefield for the Web - Web Bot Auth: VERIFY a signed agent, not just notice it.
 *
 * An AI agent can sign its requests with HTTP Message Signatures (RFC 9421) under
 * the Web Bot Auth profile (draft-meunier-web-bot-auth-architecture): a
 * Signature-Input / Signature pair tagged "web-bot-auth", and usually a
 * Signature-Agent header naming the origin that publishes its keys at
 * /.well-known/http-message-signatures-directory
 * (draft-meunier-http-message-signatures-directory). Until now the engine saw the
 * header NAMES only, so a request carrying three made-up headers was welcomed as a
 * "signed agent". This module checks the signature.
 *
 * Verdicts (precision first, fail-open on anything we cannot decide):
 *   verified      - a key from the agent's own directory verifies the signature,
 *                   within its created/expires window, tag web-bot-auth, covering
 *                   the authority (and the Signature-Agent member when present)
 *   invalid       - the signature, its parameters or its key binding are wrong:
 *                   a forged or replayed signature (reported, never blocked here)
 *   unverifiable  - we could not decide: the agent is not on the ruleset's list of
 *                   signature agents (we never fetch an arbitrary URL a request
 *                   names: that would let anyone make every site call them), the
 *                   directory was unreachable, the algorithm is not one we verify,
 *                   or this runtime has no Ed25519. The reason says which.
 *
 * Crypto agility: algorithms are looked up in WBA_ALGORITHMS by name. Ed25519 is
 * implemented; RSA-PSS, ECDSA and an ML-DSA slot are reserved (unverifiable until
 * added). The test vectors are RFC 9421 Appendix B.1.4 / B.2.6 and the Web Bot
 * Auth draft Appendix A.2 (see __tests__/web-bot-auth.test.ts).
 *
 * EDGE-SAFE: WebCrypto + fetch only; the fetch and clock are injected for tests.
 */

export type SignatureVerdict = "verified" | "invalid" | "unverifiable";

export interface AgentSignatureResult {
  verdict: SignatureVerdict;
  /** Short machine reason, recorded on the event (never the signature itself). */
  reason: string;
  /** The verified agent's origin host (e.g. "chatgpt.com"), when verified. */
  agent?: string;
}

/** Origins whose key directories we fetch. Bundled default; the central ruleset
 *  extends it (ruleset.signatureAgents) so a new agent is added once. */
export const DEFAULT_SIGNATURE_AGENTS: readonly string[] = ["https://chatgpt.com"];

export const DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";
const DIRECTORY_TIMEOUT_MS = 1500;
const DIRECTORY_MAX_BYTES = 64 * 1024;
const DIRECTORY_TTL_MS = 60 * 60 * 1000;
/** Allowed clock skew on `created` (an agent's clock running a little ahead). */
const CLOCK_SKEW_S = 60;

/* --------------------------- structured fields (RFC 8941) --------------------------- */

type Bare = string | number | boolean | { bytes: string } | { token: string };
interface Item { value: Bare; params: Array<[string, Bare]> }
interface InnerList { items: Item[]; params: Array<[string, Bare]> }

class Cursor {
  i = 0;
  constructor(readonly s: string) {}
  peek(): string { return this.s[this.i] ?? ""; }
  eat(c: string): boolean { if (this.s[this.i] === c) { this.i++; return true; } return false; }
  ows(): void { while (this.s[this.i] === " " || this.s[this.i] === "\t") this.i++; }
  sp(): void { while (this.s[this.i] === " ") this.i++; }
  done(): boolean { return this.i >= this.s.length; }
}

function fail(): never { throw new Error("structured field"); }

function parseKey(c: Cursor): string {
  const m = /^[a-z*][a-z0-9_\-.*]*/.exec(c.s.slice(c.i));
  if (!m) fail();
  c.i += m[0].length;
  return m[0];
}

function parseBare(c: Cursor): Bare {
  const ch = c.peek();
  if (ch === '"') {
    c.i++;
    let out = "";
    for (;;) {
      if (c.done()) fail();
      const x = c.s[c.i++];
      if (x === "\\") { const n = c.s[c.i++]; if (n !== '"' && n !== "\\") fail(); out += n; }
      else if (x === '"') return out;
      else if (x < " " || x > "~") fail();
      else out += x;
    }
  }
  if (ch === ":") {
    c.i++;
    const end = c.s.indexOf(":", c.i);
    if (end < 0) fail();
    const b = c.s.slice(c.i, end);
    if (!/^[A-Za-z0-9+/=]*$/.test(b)) fail();
    c.i = end + 1;
    return { bytes: b };
  }
  if (ch === "?") { c.i++; const v = c.s[c.i++]; if (v === "1") return true; if (v === "0") return false; fail(); }
  const num = /^-?\d{1,15}(\.\d{1,3})?/.exec(c.s.slice(c.i));
  if (num) { c.i += num[0].length; return Number(num[0]); }
  const tok = /^[A-Za-z*][A-Za-z0-9!#$%&'*+\-.^_`|~:/]*/.exec(c.s.slice(c.i));
  if (tok) { c.i += tok[0].length; return { token: tok[0] }; }
  return fail();
}

function parseParams(c: Cursor): Array<[string, Bare]> {
  const out: Array<[string, Bare]> = [];
  while (c.eat(";")) {
    c.sp();
    const k = parseKey(c);
    out.push([k, c.eat("=") ? parseBare(c) : true]);
  }
  return out;
}

function parseItemOrList(c: Cursor): Item | InnerList {
  if (c.eat("(")) {
    const items: Item[] = [];
    for (;;) {
      c.sp();
      if (c.eat(")")) return { items, params: parseParams(c) };
      items.push({ value: parseBare(c), params: parseParams(c) });
      const n = c.peek();
      if (n !== " " && n !== ")") fail();
    }
  }
  return { value: parseBare(c), params: parseParams(c) };
}

/** An RFC 8941 dictionary, members in order (unknown shapes throw). */
export function parseDictionary(s: string): Map<string, Item | InnerList> {
  const c = new Cursor(s.trim());
  const out = new Map<string, Item | InnerList>();
  while (!c.done()) {
    const k = parseKey(c);
    out.set(k, c.eat("=") ? parseItemOrList(c) : { value: true, params: parseParams(c) });
    c.ows();
    if (c.done()) break;
    if (!c.eat(",")) fail();
    c.ows();
  }
  return out;
}

function serializeBare(v: Bare): string {
  if (typeof v === "string") return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "?1" : "?0";
  if ("bytes" in v) return `:${v.bytes}:`;
  return v.token;
}
function serializeParams(p: Array<[string, Bare]>): string {
  return p.map(([k, v]) => (v === true ? `;${k}` : `;${k}=${serializeBare(v)}`)).join("");
}
function serializeInnerList(l: InnerList): string {
  return `(${l.items.map((i) => serializeBare(i.value) + serializeParams(i.params)).join(" ")})${serializeParams(l.params)}`;
}
const param = (p: Array<[string, Bare]>, k: string): Bare | undefined => p.find(([n]) => n === k)?.[1];

/* --------------------------------- the request --------------------------------- */

export interface SignedRequest {
  method: string;
  /** The full request URL as received (scheme, authority, path, query). */
  url: string;
  /** Header lookup by lowercased name (a Headers object or a small map). */
  header: (name: string) => string | null;
}

/**
 * How a dictionary member (`"signature-agent";key="agent2"`) enters the base.
 * "rfc": its serialized value, quotes included (RFC 9421 section 2.1.2).
 * "bare": the string without quotes. The Web Bot Auth draft's own A.2.2 vector
 * displays the quoted form but its published signature only verifies over the
 * bare form (checked 2026-10-30), so signers following that vector sign "bare";
 * the verifier accepts either (same value, same key) and records which matched.
 */
export type MemberStyle = "rfc" | "bare";

/** The signature base (RFC 9421 section 2.5) for one signature. Throws on a
 *  component we cannot produce (the caller treats that as invalid). */
export function signatureBase(req: SignedRequest, input: InnerList, memberStyle: MemberStyle = "rfc"): string {
  const u = new URL(req.url);
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const it of input.items) {
    if (typeof it.value !== "string") fail();
    const name = it.value;
    const id = serializeBare(name) + serializeParams(it.params);
    if (seen.has(id)) fail();
    seen.add(id);
    let value: string;
    switch (name) {
      case "@authority": value = u.host.toLowerCase(); break;
      case "@method": value = req.method.toUpperCase(); break;
      case "@path": value = u.pathname || "/"; break;
      case "@query": value = u.search || "?"; break;
      case "@scheme": value = u.protocol.replace(":", "").toLowerCase(); break;
      case "@target-uri": value = u.href; break;
      case "@request-target": value = `${u.pathname}${u.search}`; break;
      default: {
        if (name.startsWith("@")) fail();
        const raw = req.header(name);
        if (raw === null) fail();
        const key = param(it.params, "key");
        if (typeof key === "string") {
          const member = parseDictionary(raw).get(key);
          if (!member || "items" in member) fail();
          value = memberStyle === "bare" && typeof member.value === "string" && member.params.length === 0
            ? member.value
            : serializeBare(member.value) + serializeParams(member.params);
        } else {
          value = raw.trim().replace(/\s*\n\s*/g, " ");
        }
      }
    }
    lines.push(`${id}: ${value}`);
  }
  lines.push(`"@signature-params": ${serializeInnerList(input)}`);
  return lines.join("\n");
}

/* --------------------------------- keys + crypto -------------------------------- */

export interface Jwk { kty?: string; crv?: string; x?: string; [k: string]: unknown }

const b64url = (bytes: ArrayBuffer | Uint8Array) => {
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of a) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

/** The key's JWK SHA-256 thumbprint (RFC 7638; RFC 8037 A.3 for OKP), the
 *  Web Bot Auth keyid. Null for a key type we do not handle. */
export async function jwkThumbprint(k: Jwk): Promise<string | null> {
  if (k.kty !== "OKP" || typeof k.crv !== "string" || typeof k.x !== "string") return null;
  const canon = JSON.stringify({ crv: k.crv, kty: k.kty, x: k.x });
  return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon)));
}

type Verifier = (key: Jwk, signature: Uint8Array, data: Uint8Array) => Promise<boolean>;

/** Named algorithms (crypto agility). Null = reserved, not verified yet. */
export const WBA_ALGORITHMS: Readonly<Record<string, Verifier | null>> = {
  ed25519: async (key, signature, data) => {
    if (key.kty !== "OKP" || key.crv !== "Ed25519" || typeof key.x !== "string") return false;
    const k = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: key.x }, { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify("Ed25519", k, signature, data);
  },
  "rsa-pss-sha512": null,
  "ecdsa-p256-sha256": null,
  "ml-dsa-65": null, // post-quantum slot, reserved
};

/** The directory's keys: { keys: [...] } (JWKS) or the draft's { keys: {...} }. */
export function directoryKeys(body: unknown): Jwk[] {
  const keys = (body as { keys?: unknown } | null)?.keys;
  if (Array.isArray(keys)) return keys.filter((k): k is Jwk => !!k && typeof k === "object");
  if (keys && typeof keys === "object") return [keys as Jwk];
  return [];
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const directoryCache = new Map<string, { at: number; keys: Jwk[] }>();
export function _resetDirectoryCache(): void { directoryCache.clear(); }

async function fetchDirectory(origin: string, f: FetchLike, nowMs: number): Promise<Jwk[] | null> {
  const hit = directoryCache.get(origin);
  if (hit && nowMs - hit.at < DIRECTORY_TTL_MS) return hit.keys;
  try {
    const r = await f(`${origin}${DIRECTORY_PATH}`, {
      signal: AbortSignal.timeout(DIRECTORY_TIMEOUT_MS),
      headers: { accept: "application/http-message-signatures-directory+json" },
    });
    if (!r.ok) return null;
    const text = await r.text();
    if (text.length > DIRECTORY_MAX_BYTES) return null;
    const keys = directoryKeys(JSON.parse(text));
    directoryCache.set(origin, { at: nowMs, keys });
    return keys;
  } catch {
    return null;
  }
}

/** The origin a Signature-Agent value names (dictionary member or legacy string). */
function agentOrigin(raw: string | null, coveredKey: string | undefined): string | null {
  if (!raw) return null;
  try {
    const d = parseDictionary(raw);
    const m = coveredKey ? d.get(coveredKey) : [...d.values()][0];
    if (m && !("items" in m) && typeof m.value === "string") return new URL(m.value).origin;
  } catch { /* legacy sf-string form below */ }
  try {
    const c = new Cursor(raw.trim());
    const v = parseBare(c);
    if (typeof v === "string" && c.done()) return new URL(v).origin;
  } catch { /* not a URL */ }
  return null;
}

/**
 * Verify the Web Bot Auth signature on a request. Never throws. `agents` is the
 * list of origins whose directories may be fetched (ruleset + bundled default).
 */
export async function verifyAgentSignature(
  req: SignedRequest,
  opts: { agents?: readonly string[]; fetchImpl?: FetchLike; nowMs?: number; keys?: Jwk[] } = {},
): Promise<AgentSignatureResult> {
  const nowS = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  let inputs: Map<string, Item | InnerList>;
  let sigs: Map<string, Item | InnerList>;
  try {
    inputs = parseDictionary(req.header("signature-input") ?? "");
    sigs = parseDictionary(req.header("signature") ?? "");
  } catch {
    return { verdict: "invalid", reason: "malformed_signature_headers" };
  }
  // The Web Bot Auth signature among possibly several.
  const label = [...inputs.keys()].find((l) => {
    const v = inputs.get(l);
    return !!v && "items" in v && param(v.params, "tag") === "web-bot-auth";
  });
  if (!label) return { verdict: "invalid", reason: "no_web_bot_auth_signature" };
  const input = inputs.get(label) as InnerList;
  const sig = sigs.get(label);
  if (!sig || "items" in sig || typeof sig.value !== "object" || !("bytes" in sig.value)) return { verdict: "invalid", reason: "signature_missing_for_label" };

  const created = param(input.params, "created"), expires = param(input.params, "expires"), keyid = param(input.params, "keyid");
  if (typeof created !== "number" || typeof expires !== "number" || typeof keyid !== "string") return { verdict: "invalid", reason: "missing_required_parameter" };
  if (created > nowS + CLOCK_SKEW_S) return { verdict: "invalid", reason: "created_in_future" };
  if (expires <= nowS) return { verdict: "invalid", reason: "expired" };

  const names = input.items.map((i) => i.value);
  if (!names.includes("@authority") && !names.includes("@target-uri")) return { verdict: "invalid", reason: "authority_not_covered" };
  const agentItem = input.items.find((i) => i.value === "signature-agent");
  const agentHeader = req.header("signature-agent");
  if (agentHeader !== null && !agentItem) return { verdict: "invalid", reason: "signature_agent_not_covered" };

  const alg = param(input.params, "alg");
  const algName = typeof alg === "string" ? alg : "ed25519";
  const verifier = WBA_ALGORITHMS[algName];
  if (verifier === undefined) return { verdict: "invalid", reason: "unknown_algorithm" };
  if (verifier === null) return { verdict: "unverifiable", reason: `algorithm_not_supported:${algName}` };

  let bases: Array<[MemberStyle, string]>;
  try {
    const rfc = signatureBase(req, input, "rfc");
    const bare = signatureBase(req, input, "bare");
    bases = rfc === bare ? [["rfc", rfc]] : [["rfc", rfc], ["bare", bare]];
  } catch {
    return { verdict: "invalid", reason: "signature_base_unbuildable" };
  }

  // The key: from the agent's own directory, matched by thumbprint (never by kid).
  let keys = opts.keys;
  let agent: string | undefined;
  if (!keys) {
    const coveredKey = agentItem ? param(agentItem.params, "key") : undefined;
    const origin = agentOrigin(agentHeader, typeof coveredKey === "string" ? coveredKey : undefined);
    if (!origin) return { verdict: "unverifiable", reason: "no_signature_agent" };
    if (!origin.startsWith("https://")) return { verdict: "invalid", reason: "signature_agent_not_https" };
    const allowed = new Set([...DEFAULT_SIGNATURE_AGENTS, ...(opts.agents ?? [])].map((o) => o.replace(/\/+$/, "").toLowerCase()));
    if (!allowed.has(origin.toLowerCase())) return { verdict: "unverifiable", reason: "agent_not_listed" };
    const f = opts.fetchImpl ?? ((u, i) => fetch(u, i as RequestInit));
    const got = await fetchDirectory(origin, f, opts.nowMs ?? Date.now());
    if (!got) return { verdict: "unverifiable", reason: "directory_unreachable" };
    keys = got;
    agent = new URL(origin).host;
  }
  let key: Jwk | undefined;
  try {
    for (const k of keys) if ((await jwkThumbprint(k)) === keyid) { key = k; break; }
  } catch {
    return { verdict: "unverifiable", reason: "runtime_no_sha256" };
  }
  if (!key) return { verdict: "invalid", reason: "keyid_not_in_directory" };

  try {
    const bytes = fromB64(sig.value.bytes);
    for (const [style, base] of bases) {
      if (await verifier(key, bytes, new TextEncoder().encode(base))) {
        return { verdict: "verified", reason: style === "rfc" ? "signature_verified" : "signature_verified_bare_member", ...(agent ? { agent } : {}) };
      }
    }
    return { verdict: "invalid", reason: "bad_signature" };
  } catch {
    // importKey / verify unavailable: this runtime has no Ed25519.
    return { verdict: "unverifiable", reason: `runtime_no_${algName}` };
  }
}
