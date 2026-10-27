#!/usr/bin/env node
/**
 * Forcefield Edge LIVE proof against a deployed hostname whose origin is an echo
 * service that returns the request it received as JSON (httpbin-style
 * `/anything`: { method, url, headers, data, files, form }).
 *
 *   EDGE_HOST=edge-test.ogiam.com \
 *   EDGE_PROJECT_HOST=<edge-project>.vercel.app \
 *   EDGE_ORIGIN_SECRET=<the secret set_origin returned, optional> \
 *   node edge/scripts/live-proof.mjs
 *
 * Exit 0 only when every case passes. Sends the PR #1266 attack SHAPES (inert
 * markers, no exploit) to our own test hostname only.
 */
const HOST = process.env.EDGE_HOST;
const PROJECT_HOST = process.env.EDGE_PROJECT_HOST;
const SECRET = process.env.EDGE_ORIGIN_SECRET ?? "";
if (!HOST) {
  console.error("set EDGE_HOST (and EDGE_PROJECT_HOST for the unknown-hostname case)");
  process.exit(2);
}
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const BASE = { "user-agent": UA, accept: "text/html,application/json;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.9" };

async function call(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...BASE, ...(init.headers ?? {}) }, redirect: "manual" });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, headers: res.headers, text, json };
}
const header = (echo, name) => {
  const h = echo?.headers ?? {};
  const k = Object.keys(h).find((x) => x.toLowerCase() === name);
  return k ? h[k] : undefined;
};
const multipart = (b, parts) => parts.map((p) => `--${b}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ""}\r\n\r\n${p.value}\r\n`).join("") + `--${b}--\r\n`;

const results = [];
async function check(name, fn) {
  try {
    results.push({ name, ok: true, detail: await fn() });
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
  }
}
const expect = (c, m) => {
  if (!c) throw new Error(m);
};

await check("GET passes through with x-forcefield-edge", async () => {
  const r = await call(`https://${HOST}/anything/hello?x=1`, { headers: { "x-forcefield-edge": "forged" } });
  expect(r.status === 200, `status ${r.status}`);
  const got = header(r.json, "x-forcefield-edge");
  expect(got && got !== "forged", `origin saw x-forcefield-edge=${got}`);
  if (SECRET) expect(got === SECRET, "x-forcefield-edge is not the tenant secret");
  expect(header(r.json, "x-forwarded-host") === HOST, `x-forwarded-host ${header(r.json, "x-forwarded-host")}`);
  return `200, origin saw ${r.json?.method} ${r.json?.url}; forged header replaced`;
});

await check("POST JSON body intact", async () => {
  const body = JSON.stringify({ hello: "world", n: 42 });
  const r = await call(`https://${HOST}/anything/form`, { method: "POST", headers: { "content-type": "application/json" }, body });
  expect(r.status === 200, `status ${r.status}`);
  expect(r.json?.data === body, "body changed");
  return "200, body echoed byte for byte";
});

await check("3.5 MB upload passes intact", async () => {
  const file = "A".repeat(3.5 * 1024 * 1024);
  const body = multipart("UploadBoundary", [{ name: "async-upload", filename: "photo.txt", value: file }]);
  const r = await call(`https://${HOST}/anything/upload`, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=UploadBoundary" }, body });
  expect(r.status === 200, `status ${r.status}`);
  const got = r.json?.files?.["async-upload"] ?? "";
  expect(got.length === file.length, `origin got ${got.length} of ${file.length}`);
  return `200, ${file.length} bytes echoed`;
});

await check("over 4 MB -> 413", async () => {
  const r = await call(`https://${HOST}/anything/big`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: "a".repeat(4 * 1024 * 1024 + 1024) });
  expect(r.status === 413, `status ${r.status}`);
  return `413 (${r.headers.get("x-vercel-id") ? "answered on the platform" : "answered"})`;
});

await check("PHP2Shell shape -> 403", async () => {
  const body = multipart("WpBoundary", [{ name: "PHP_SESSION_UPLOAD_PROGRESS", value: "x" }, { name: "files[a][b][c][d][e][f]", value: "y" }]);
  const r = await call(`https://${HOST}/anything/wp-admin/admin-ajax.php`, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=WpBoundary" }, body });
  expect(r.status === 403, `status ${r.status}`);
  return `403 ${r.headers.get("x-forcefield")}`;
});

await check("React2Shell shape -> 403", async () => {
  const body = '--B\r\nContent-Disposition: form-data; name="1_$ACTION"\r\n\r\n[{"x":"$1:__proto__:then"}]\r\n--B--\r\n';
  const r = await call(`https://${HOST}/anything/`, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=B", "next-action": "x" }, body });
  expect(r.status === 403, `status ${r.status}`);
  return `403 ${r.headers.get("x-forcefield")}`;
});

if (PROJECT_HOST) {
  await check("a hostname with no tenant -> 421", async () => {
    const r = await call(`https://${PROJECT_HOST}/`);
    expect(r.status === 421, `status ${r.status}`);
    return "421";
  });
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}\n      ${r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
