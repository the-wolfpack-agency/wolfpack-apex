#!/usr/bin/env node
/**
 * Local proof stubs for Forcefield Edge. Two tiny HTTP servers, no dependencies:
 *
 *   ORIGIN  (default :3911) - stands in for a client's own server. Echoes what it
 *           received (method, path, the Edge headers, body length + sha256) and
 *           counts every request, so the proof can show a blocked request never
 *           reached it.
 *   APEX    (default :3912) - stands in for the two apex endpoints Edge calls:
 *           GET  /api/forcefield/edge/site?host=   (site lookup, service-token gated)
 *           POST /api/site-analytics/ingest        (observations, recorded in memory)
 *           GET  /__events                          (what the ingest received)
 *
 * Hostnames served: edge-test.local (enforce on), edge-watch.local (watch only).
 * Anything else is unknown (404 from the lookup -> Edge answers 421).
 *
 * Used by scripts/local-proof.sh. Not deployed.
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const ORIGIN_PORT = Number(process.env.EDGE_PROOF_ORIGIN_PORT ?? 3911);
const APEX_PORT = Number(process.env.EDGE_PROOF_APEX_PORT ?? 3912);
const SERVICE_TOKEN = process.env.FORCEFIELD_EDGE_SERVICE_TOKEN ?? "";
export const PROOF_SECRET = process.env.EDGE_PROOF_ORIGIN_SECRET ?? "ffe_local-proof-origin-secret-0123456789abcdef";

const SITES = {
  "edge-test.local": { tenantId: "00000000-0000-4000-8000-000000000001", siteLabel: "edge-test.local", enforce: true },
  "edge-watch.local": { tenantId: "00000000-0000-4000-8000-000000000002", siteLabel: "edge-watch.local", enforce: false },
};

let originSeen = 0;
const events = [];

createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.url === "/__seen") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ seen: originSeen }));
      return;
    }
    originSeen++;
    const body = Buffer.concat(chunks);
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(
      JSON.stringify({
        method: req.method,
        url: req.url,
        host: req.headers.host,
        edgeHeader: req.headers["x-forcefield-edge"] ?? null,
        forwardedHost: req.headers["x-forwarded-host"] ?? null,
        forwardedProto: req.headers["x-forwarded-proto"] ?? null,
        syntheticHeader: req.headers["x-forcefield-synthetic"] ?? null,
        tenantHeader: req.headers["x-forcefield-edge-tenant"] ?? null,
        contentType: req.headers["content-type"] ?? null,
        bodyLength: body.length,
        bodySha256: createHash("sha256").update(body).digest("hex"),
      }),
    );
  });
}).listen(ORIGIN_PORT, "127.0.0.1", () => console.log(`origin stub on :${ORIGIN_PORT}`));

createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const url = new URL(req.url, "http://apex.local");
    const json = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === "/__events") return json(200, { events });
    if (url.pathname === "/api/forcefield/edge/site") {
      if (!SERVICE_TOKEN || req.headers["x-edge-service-token"] !== SERVICE_TOKEN) return json(401, { ok: false, error: "unauthorized" });
      const host = url.searchParams.get("host") ?? "";
      const s = SITES[host];
      if (!s) return json(404, { ok: false, error: "unknown_host" });
      return json(200, { ok: true, site: { ...s, originUrl: `http://127.0.0.1:${ORIGIN_PORT}`, originSecret: PROOF_SECRET, platform: "wordpress" } });
    }
    if (url.pathname === "/api/site-analytics/ingest" && req.method === "POST") {
      let parsed = null;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* recorded as null */
      }
      events.push({
        tokenOk: req.headers["x-ingest-token"] === SERVICE_TOKEN,
        tenant: req.headers["x-forcefield-edge-tenant"] ?? null,
        type: parsed?.type ?? null,
        path: parsed?.path ?? null,
        attack: parsed?.props?.attack ?? null,
        blocked: parsed?.props?.blocked ?? null,
        wouldBlock: parsed?.props?.would_block ?? null,
      });
      return json(200, { ok: true });
    }
    json(404, { ok: false });
  });
}).listen(APEX_PORT, "127.0.0.1", () => console.log(`apex stub on :${APEX_PORT}`));
