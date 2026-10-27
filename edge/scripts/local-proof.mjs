#!/usr/bin/env node
/**
 * Forcefield Edge local proof: drives a RUNNING edge (`next start`) that sits in
 * front of the origin stub, and asserts each case. Exit 0 only when every case
 * passes. Run through scripts/local-proof.sh, which starts and stops everything.
 *
 * The attack bodies are the request shapes from the PR #1266 fixtures
 * (src/lib/forcefield-web/__tests__/body-inspect.test.ts and the Worker adapter
 * test), sent over real HTTP.
 */
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";

const EDGE = process.env.EDGE_PROOF_EDGE_URL ?? "http://127.0.0.1:3910";
const ORIGIN = `http://127.0.0.1:${process.env.EDGE_PROOF_ORIGIN_PORT ?? 3911}`;
const APEX = `http://127.0.0.1:${process.env.EDGE_PROOF_APEX_PORT ?? 3912}`;
const SECRET = process.env.EDGE_PROOF_ORIGIN_SECRET ?? "ffe_local-proof-origin-secret-0123456789abcdef";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/** Raw HTTP so the Host header is ours to set (fetch forbids it). */
function send(path, { method = "GET", host = "edge-test.local", headers = {}, body } = {}) {
  const u = new URL(path, EDGE);
  const buf = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1");
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          host,
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          "accept-encoding": "identity",
          ...(buf ? { "content-length": String(buf.length) } : {}),
          ...headers,
        },
        timeout: 30_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not json */
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout (request hung)")));
    req.on("error", reject);
    if (buf) req.write(buf);
    req.end();
  });
}

const sha = (b) => createHash("sha256").update(b).digest("hex");
const originSeen = async () => (await (await fetch(`${ORIGIN}/__seen`)).json()).seen;
const apexEvents = async () => (await (await fetch(`${APEX}/__events`)).json()).events;

function multipart(boundary, parts) {
  let out = "";
  for (const p of parts) {
    out += `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) out += `; filename="${p.filename}"`;
    out += "\r\n\r\n" + (p.value ?? "x") + "\r\n";
  }
  return out + `--${boundary}--\r\n`;
}

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
  }
}
function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

await check("GET passes through intact (path, query, Edge headers)", async () => {
  const r = await send("/hello/world?x=1&y=two");
  expect(r.status === 200, `status ${r.status}: ${r.text.slice(0, 200)}`);
  expect(r.json.method === "GET", `method ${r.json.method}`);
  expect(r.json.url === "/hello/world?x=1&y=two", `url ${r.json.url}`);
  expect(r.json.edgeHeader === SECRET, "x-forcefield-edge missing or wrong");
  expect(r.json.forwardedHost === "edge-test.local", `x-forwarded-host ${r.json.forwardedHost}`);
  return `200, origin saw GET ${r.json.url}, x-forcefield-edge = tenant secret, x-forwarded-host = ${r.json.forwardedHost}`;
});

await check("a visitor-forged x-forcefield-edge / synthetic header never reaches the origin", async () => {
  const r = await send("/", { headers: { "x-forcefield-edge": "forged", "x-forcefield-synthetic": "guess", "x-forcefield-edge-tenant": "x" } });
  expect(r.status === 200, `status ${r.status}`);
  expect(r.json.edgeHeader === SECRET, `origin saw ${r.json.edgeHeader}`);
  expect(r.json.syntheticHeader === null && r.json.tenantHeader === null, "stripped headers leaked");
  return "origin saw the real tenant secret; forged values stripped";
});

await check("POST JSON passes with body intact", async () => {
  const body = JSON.stringify({ name: "Ada", message: "hello from a real form", n: 42 });
  const r = await send("/api/contact", { method: "POST", headers: { "content-type": "application/json" }, body });
  expect(r.status === 200, `status ${r.status}`);
  expect(r.json.method === "POST", `method ${r.json.method}`);
  expect(r.json.bodySha256 === sha(Buffer.from(body)), "body changed in transit");
  return `200, ${r.json.bodyLength} bytes, sha256 match`;
});

await check("large legitimate upload (3.5 MB multipart, well over the 256 KB scan cap) passes intact", async () => {
  const file = randomBytes(3.5 * 1024 * 1024).toString("base64").slice(0, 3.5 * 1024 * 1024);
  const body = Buffer.from(multipart("UploadBoundary", [{ name: "action", value: "upload-attachment" }, { name: "async-upload", filename: "photo.jpg", value: file }]), "latin1");
  const t0 = Date.now();
  const r = await send("/wp-admin/async-upload.php", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=UploadBoundary" }, body });
  expect(r.status === 200, `status ${r.status}: ${r.text.slice(0, 200)}`);
  expect(r.json.bodyLength === body.length, `origin got ${r.json.bodyLength} of ${body.length} bytes`);
  expect(r.json.bodySha256 === sha(body), "upload changed in transit");
  return `200 in ${Date.now() - t0} ms, ${body.length} bytes, sha256 match (no hang)`;
});

await check("an upload over the 4 MB platform limit is refused with 413, never truncated", async () => {
  const before = await originSeen();
  const body = Buffer.alloc(4 * 1024 * 1024 + 1024, 0x61);
  const r = await send("/upload", { method: "POST", headers: { "content-type": "application/octet-stream" }, body }).catch((e) => ({ status: 0, text: e.message }));
  expect(r.status === 413, `status ${r.status}`);
  expect((await originSeen()) === before, "origin was reached");
  return "413, origin not reached";
});

await check("PHP2Shell: PHP_SESSION_UPLOAD_PROGRESS + deep nesting is blocked before the origin", async () => {
  const before = await originSeen();
  const body = multipart("WpBoundary", [{ name: "PHP_SESSION_UPLOAD_PROGRESS", value: "x" }, { name: "files[a][b][c][d][e][f]", value: "y" }]);
  const r = await send("/wp-admin/admin-ajax.php", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=WpBoundary" }, body });
  expect(r.status === 403, `status ${r.status}`);
  expect(r.headers["x-forcefield"] === "blocked:payload", `x-forcefield ${r.headers["x-forcefield"]}`);
  expect((await originSeen()) === before, "origin was reached");
  return "403 blocked:payload, origin not reached";
});

await check("PHP2Shell: abnormal part count (300 parts) is blocked", async () => {
  const before = await originSeen();
  const parts = Array.from({ length: 300 }, (_, i) => ({ name: `f${i}`, value: "1" }));
  const r = await send("/index.php", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=WpBoundary" }, body: multipart("WpBoundary", parts) });
  expect(r.status === 403, `status ${r.status}`);
  expect((await originSeen()) === before, "origin was reached");
  return "403, origin not reached";
});

await check("React2Shell: Flight reference + __proto__ in a Server Action body is blocked", async () => {
  const before = await originSeen();
  const body = '--B\r\nContent-Disposition: form-data; name="1_$ACTION"\r\n\r\n[{"x":"$1:__proto__:then"}]\r\n--B--\r\n';
  const r = await send("/", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=B", "next-action": "x" }, body });
  expect(r.status === 403, `status ${r.status}`);
  expect((await originSeen()) === before, "origin was reached");
  return "403, origin not reached";
});

await check("a benign Server Action POST (next-action header, ordinary Flight body) passes", async () => {
  const body = '[{"id":"$K1"},"hello"]';
  const r = await send("/dashboard", { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8", "next-action": "7f3a9c" }, body });
  expect(r.status === 200, `status ${r.status}`);
  expect(r.json.bodySha256 === sha(Buffer.from(body)), "body changed");
  return "200, body intact";
});

await check("watch-first tenant: the same PHP2Shell body is forwarded and recorded as would-block", async () => {
  const body = multipart("WpBoundary", [{ name: "PHP_SESSION_UPLOAD_PROGRESS", value: "x" }, { name: "files[a][b][c][d][e][f]", value: "y" }]);
  const r = await send("/wp-admin/admin-ajax.php", { host: "edge-watch.local", method: "POST", headers: { "content-type": "multipart/form-data; boundary=WpBoundary" }, body });
  expect(r.status === 200, `status ${r.status}`);
  return "200 forwarded (tenant enforce off)";
});

await check("an unknown hostname is refused (421) and never forwarded", async () => {
  const before = await originSeen();
  const r = await send("/", { host: "not-a-tenant.example" });
  expect(r.status === 421, `status ${r.status}`);
  expect((await originSeen()) === before, "origin was reached");
  return "421, origin not reached";
});

await check("events reached the ingest, attributed to the tenant with the service token", async () => {
  await new Promise((r) => setTimeout(r, 750)); // waitUntil forwards settle
  const ev = await apexEvents();
  expect(ev.length > 0, "no events");
  expect(ev.every((e) => e.tokenOk), "an event without the service token");
  const blocked = ev.filter((e) => e.type === "site.agent_payload_attack" && e.blocked === true && e.tenant === "00000000-0000-4000-8000-000000000001");
  const attacks = new Set(blocked.map((e) => e.attack));
  expect(attacks.has("php2shell") && attacks.has("react2shell"), `blocked attacks recorded: ${[...attacks].join(",")}`);
  const watched = ev.find((e) => e.tenant === "00000000-0000-4000-8000-000000000002" && e.attack === "php2shell" && e.wouldBlock === true);
  expect(watched, "watch tenant would-block event missing");
  return `${ev.length} events; blocked attacks: ${[...attacks].join(", ")}; watch tenant recorded would_block`;
});

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}\n      ${r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
