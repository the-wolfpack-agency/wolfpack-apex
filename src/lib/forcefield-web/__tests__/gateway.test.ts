/** @jest-environment node */
/**
 * The gateway core shared by every proxy adapter (Cloudflare Worker, Forcefield
 * Edge): the Edge contract helpers, the bounded body read (including the
 * over-cap streaming body that used to deadlock), and decideEdgeRequest under
 * enforce and watch postures.
 */
import {
  normalizeEdgeHost,
  canonicalOrigin,
  coerceEdgeSite,
  originTarget,
  isForwardLoop,
  forwardRequestHeaders,
  declaredBodyLength,
  inspectBodyBounded,
  decideEdgeRequest,
  edgeBlockResponse,
  edgeDecoyResponse,
  EDGE_ORIGIN_HEADER,
  EDGE_TENANT_HEADER,
  type EdgeSite,
  type RequestSignals,
} from "../gateway";
import { BODY_SCAN_CAP_BYTES } from "../body-inspect";
import { DEFAULT_RULESET } from "../ruleset";
import { IntentLedger } from "../intent";

const SECRET = "ffe_" + "a".repeat(43);
const SITE: EdgeSite = { tenantId: "t-1", siteLabel: "client.example", originUrl: "https://origin.client.example", originSecret: SECRET, enforce: true, platform: "wordpress" };
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const BROWSER = { "user-agent": UA, accept: "text/html", "accept-language": "en-US", "accept-encoding": "gzip" };

/** A request body that arrives as a stream in chunks, like a real incoming
 *  request (a buffered Uint8Array body does not reproduce the tee deadlock). */
function streamingBody(bytes: number, chunk = 65_536, fill = 0x61): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(c) {
        if (sent >= bytes) return c.close();
        const n = Math.min(chunk, bytes - sent);
        c.enqueue(new Uint8Array(n).fill(fill));
        sent += n;
      },
    },
    { highWaterMark: 0 },
  );
}

function signals(req: Request, over: Partial<RequestSignals> = {}): RequestSignals {
  return {
    url: new URL(req.url),
    method: req.method,
    userAgent: req.headers.get("user-agent") ?? "",
    country: "US",
    ip: "203.0.113.7",
    accept: req.headers.get("accept") ?? "",
    secFetchDest: "",
    authenticated: false,
    headerNames: Array.from(req.headers.keys()),
    nowMs: Date.UTC(2026, 9, 26, 12),
    ...over,
  };
}

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`hung > ${ms} ms`)), ms))]);

describe("host / origin helpers", () => {
  it("normalizeEdgeHost: case, port, trailing dot; junk refused", () => {
    expect(normalizeEdgeHost("WWW.Client.Example:443")).toBe("www.client.example");
    expect(normalizeEdgeHost("client.example.")).toBe("client.example");
    for (const bad of [null, "", "[::1]:80", "a b", "host:port", "-bad.example"]) expect(normalizeEdgeHost(bad)).toBeNull();
  });

  it("canonicalOrigin: https scheme + host only; http only when allowed", () => {
    expect(canonicalOrigin("https://o.example")).toBe("https://o.example");
    expect(canonicalOrigin("https://o.example:8443/")).toBe("https://o.example:8443");
    expect(canonicalOrigin("http://127.0.0.1:3911")).toBeNull();
    expect(canonicalOrigin("http://127.0.0.1:3911", { allowHttp: true })).toBe("http://127.0.0.1:3911");
    for (const bad of ["https://o.example/path", "https://o.example/?q=1", "https://u:p@o.example", "javascript:alert(1)", 5]) expect(canonicalOrigin(bad)).toBeNull();
  });

  it("coerceEdgeSite: strict; a short secret or a bad origin is refused", () => {
    expect(coerceEdgeSite({ ...SITE, stack: ["php", 3, ""] })).toEqual({ ...SITE, stack: ["php"] });
    expect(coerceEdgeSite({ ...SITE, originSecret: "short" })).toBeNull();
    expect(coerceEdgeSite({ ...SITE, originUrl: "http://o.example" })).toBeNull();
    expect(coerceEdgeSite({ ...SITE, tenantId: "" })).toBeNull();
    expect(coerceEdgeSite(null)).toBeNull();
    expect(coerceEdgeSite({ ...SITE, enforce: "yes" })?.enforce).toBe(false); // only a literal true enforces
  });

  it("originTarget keeps the visitor's path and query; isForwardLoop catches origin == public host", () => {
    expect(originTarget(SITE, "https://www.client.example/a/b?x=1&y=%20").toString()).toBe("https://origin.client.example/a/b?x=1&y=%20");
    expect(isForwardLoop(SITE, "origin.client.example")).toBe(true);
    expect(isForwardLoop(SITE, "www.client.example")).toBe(false);
  });

  it("forwardRequestHeaders: strips forged contract headers + the synthetic secret, sets the tenant secret", () => {
    const h = forwardRequestHeaders(
      new Headers({ [EDGE_ORIGIN_HEADER]: "forged", [EDGE_TENANT_HEADER]: "x", "x-forcefield-synthetic": "s", cookie: "a=1", "content-type": "text/plain" }),
      SITE,
      "www.client.example",
    );
    expect(h.get(EDGE_ORIGIN_HEADER)).toBe(SECRET);
    expect(h.has(EDGE_TENANT_HEADER)).toBe(false);
    expect(h.has("x-forcefield-synthetic")).toBe(false);
    expect(h.get("x-forwarded-host")).toBe("www.client.example");
    expect(h.get("x-forwarded-proto")).toBe("https");
    expect(h.get("cookie")).toBe("a=1"); // the visitor's own headers are kept
    expect(h.get("content-type")).toBe("text/plain");
  });

  it("declaredBodyLength parses only a plain integer", () => {
    expect(declaredBodyLength(new Headers({ "content-length": "1234" }))).toBe(1234);
    expect(declaredBodyLength(new Headers())).toBeNull();
    expect(declaredBodyLength(new Headers({ "content-length": "12abc" }))).toBeNull();
  });

  it("block / decoy responses", async () => {
    const b = edgeBlockResponse("payload");
    expect(b.status).toBe(403);
    expect(b.headers.get("x-forcefield")).toBe("blocked:payload");
    expect(edgeDecoyResponse().status).toBe(404);
  });
});

describe("inspectBodyBounded: bounded read, never a deadlock", () => {
  it("a STREAMING body far over the cap completes, and the forwarded body is whole", async () => {
    const size = 3 * 1024 * 1024; // the size that hung under `next start` with an awaited cancel
    const req = new Request("https://www.client.example/upload", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: streamingBody(size),
      duplex: "half",
    } as RequestInit);
    expect(await withTimeout(inspectBodyBounded(req), 5_000)).toBeNull();
    const forwarded = await withTimeout(req.arrayBuffer(), 5_000);
    expect(forwarded.byteLength).toBe(size);
    expect(size).toBeGreaterThan(BODY_SCAN_CAP_BYTES * 10);
  });

  it("still detects an attack marker inside the first chunk of a large streaming body", async () => {
    const head = '--B\r\nContent-Disposition: form-data; name="1_$ACTION"\r\n\r\n[{"x":"$1:__proto__:then"}]\r\n';
    const enc = new TextEncoder();
    let first = true;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (first) {
          first = false;
          return c.enqueue(enc.encode(head));
        }
        if (sent >= 2 * 1024 * 1024) return c.close();
        c.enqueue(new Uint8Array(65_536).fill(0x20));
        sent += 65_536;
      },
    }, { highWaterMark: 0 });
    const req = new Request("https://www.client.example/", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=B", "next-action": "x" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(await withTimeout(inspectBodyBounded(req), 5_000)).toBe("react2shell");
  });
});

describe("decideEdgeRequest", () => {
  const php2shell = () =>
    new Request("https://www.client.example/wp-admin/admin-ajax.php", {
      method: "POST",
      headers: { ...BROWSER, "content-type": "multipart/form-data; boundary=WpBoundary" },
      body:
        '--WpBoundary\r\nContent-Disposition: form-data; name="PHP_SESSION_UPLOAD_PROGRESS"\r\n\r\nx\r\n' +
        '--WpBoundary\r\nContent-Disposition: form-data; name="files[a][b][c][d][e][f]"\r\n\r\ny\r\n--WpBoundary--\r\n',
    });
  const run = (req: Request, over: { enforce?: boolean; site?: EdgeSite; sig?: Partial<RequestSignals> } = {}) =>
    decideEdgeRequest({
      request: req,
      site: over.site ?? SITE,
      signals: signals(req, over.sig),
      ruleset: DEFAULT_RULESET,
      enforce: over.enforce ?? true,
      intentEnforce: false,
      ledger: new IntentLedger(),
    });

  it("a normal browser GET is allowed", async () => {
    const d = await run(new Request("https://www.client.example/about", { headers: BROWSER }));
    expect(d.action).toBe("allow");
    expect(d.verdict.block).toBe(false);
  });

  it("PHP2Shell is blocked under enforce and recorded as a blocked payload attack", async () => {
    const d = await run(php2shell());
    expect(d.action).toBe("block");
    expect(d.bodyAttack).toBe("php2shell");
    expect(d.observation?.type).toBe("site.agent_payload_attack");
    expect(d.observation?.props).toMatchObject({ attack: "php2shell", blocked: true, site: "client.example" });
  });

  it("watch-first: the same body is allowed and recorded would_block", async () => {
    const d = await run(php2shell(), { enforce: false });
    expect(d.action).toBe("allow");
    expect(d.verdict.block).toBe(true);
    expect(d.observation?.props).toMatchObject({ attack: "php2shell", would_block: true });
    expect(d.observation?.props.blocked).not.toBe(true);
  });

  it("a trap-path hit answers as a decoy (404), recorded blocked", async () => {
    const trap = DEFAULT_RULESET.trapPaths[0];
    const d = await run(new Request(`https://www.client.example${trap}`, { headers: BROWSER }));
    expect(d.action).toBe("decoy");
    expect(d.observation?.props.blocked).toBe(true);
  });

  it("a verified synthetic monitor is never turned away, even on a proven-hostile request", async () => {
    const d = await run(php2shell(), { sig: { authenticated: true, synthetic: true } });
    expect(d.action).toBe("allow");
  });

  it("an injection payload in the query is blocked", async () => {
    const d = await run(new Request("https://www.client.example/search?q=1%27%20UNION%20SELECT%20password%20FROM%20users--", { headers: BROWSER }));
    expect(d.action).toBe("block");
    expect(d.verdict.reasonKind).toBe("payload");
  });
});
