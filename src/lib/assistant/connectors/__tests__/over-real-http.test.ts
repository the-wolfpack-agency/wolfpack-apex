/**
 * The connector against a real HTTP server.
 *
 * Every other connector test in this repo mocks fetch, which means they
 * all agree with whatever the code believes a vendor returns. Four bugs
 * were sitting under that agreement, and none of them were subtle: they
 * were only invisible.
 *
 * The server here answers in the shapes HubSpot and Salesforce actually
 * use, including the envelope one of them wraps every field in.
 */

export {};

import { createServer, type Server } from "node:http";
import { RestConnector } from "../rest-connector";
import { VENDOR_PRESETS } from "../vendor-presets";
import { compareRecordSets } from "@/lib/insights/cross-source-drift";

/* HubSpot: fields nested under `properties`, list under `results`. */
const HUBSPOT = [
  { id: "1", properties: { email: "jo@acme.test", firstname: "Jo", lastname: "Bell", phone: "0161 555 0101" } },
  { id: "2", properties: { email: "sam@acme.test", firstname: "Sam", lastname: "Reed", phone: "0161 555 0102" } },
  { id: "3", properties: { email: "kim@beta.test", firstname: "Kim", lastname: "Ng", phone: "0161 555 0103" } },
];
/* Salesforce: PascalCase fields, an attributes blob, list under `records`. */
const SALESFORCE = [
  { attributes: { type: "Contact" }, Id: "003x1", Email: "JO@ACME.TEST", FirstName: "Jo", LastName: "Bell", Phone: "0161 555 9999" },
  { attributes: { type: "Contact" }, Id: "003x2", Email: "sam@acme.test", FirstName: "Sam", LastName: "Reed", Phone: "0161 555 0102" },
  { attributes: { type: "Contact" }, Id: "003x4", Email: "lee@gamma.test", FirstName: "Lee", LastName: "Fox", Phone: "0161 555 0104" },
];

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (!req.headers.authorization) {
      res.statusCode = 401;
      return res.end('{"error":"unauthorized"}');
    }
    if (url.startsWith("/hs/")) return res.end(JSON.stringify({ results: HUBSPOT }));
    if (url.startsWith("/sf/")) return res.end(JSON.stringify({ records: SALESFORCE, done: true }));
    res.statusCode = 404;
    res.end('{"error":"not found"}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function connector(name: "hubspot" | "salesforce", path: string) {
  return new RestConnector({
    name,
    baseUrl: `${base}${path}`,
    authHeader: `Bearer ${name}-token`,
    vendorPreset: VENDOR_PRESETS[name],
  });
}

describe("a vendor envelope is not an empty record", () => {
  it("matches HubSpot contacts whose fields are nested under properties", async () => {
    /* Before this, every HubSpot record was unmatchable: the comparison
       read the top level, found no email and no name, and reported that
       the two systems shared no population. A confident, well-formatted,
       completely wrong answer. */
    const [hs, sf] = await Promise.all([
      connector("hubspot", "/hs").searchRecords("contact", "", 50),
      connector("salesforce", "/sf").searchRecords("contact", "", 50),
    ]);

    const report = compareRecordSets(
      "contact",
      { name: "hubspot", records: hs.data ?? [] },
      { name: "salesforce", records: sf.data ?? [] },
    );

    expect(report.matched).toBe(2);
    expect(report.unmatchable).toBe(0);
    expect(report.onlyInLeft).toBe(1);
    expect(report.onlyInRight).toBe(1);
  });

  it("matches across case, so JO@ACME.TEST is the same person as jo@acme.test", async () => {
    const [hs, sf] = await Promise.all([
      connector("hubspot", "/hs").searchRecords("contact", "", 50),
      connector("salesforce", "/sf").searchRecords("contact", "", 50),
    ]);
    const report = compareRecordSets(
      "contact",
      { name: "hubspot", records: hs.data ?? [] },
      { name: "salesforce", records: sf.data ?? [] },
    );
    /* Jo's phone genuinely differs between the two systems. */
    const phone = report.fields.find((f) => f.field === "phone");
    expect(phone?.disagreements).toBe(1);
  });

  it("does not compare the vendor's own bookkeeping", async () => {
    const sf = await connector("salesforce", "/sf").searchRecords("contact", "", 50);
    const report = compareRecordSets(
      "contact",
      { name: "a", records: sf.data ?? [] },
      { name: "b", records: sf.data ?? [] },
    );
    expect(report.fields.map((f) => f.field)).not.toContain("attributes");
  });
});

describe("a connector declares what its vendor actually holds", () => {
  it("does not claim object types the preset never maps", async () => {
    /* The generic default map adds invoice, payment and account to
       every connector, so the overlap analysis reported that invoices
       lived in both HubSpot and Salesforce when neither maps an invoice
       endpoint. A fabricated overlap is the first thing a client
       checks. */
    expect(connector("hubspot", "/hs").objectTypes?.()).toEqual([
      "contact",
      "deal",
      "company",
      "ticket",
    ]);
    expect(connector("salesforce", "/sf").objectTypes?.()).not.toContain("invoice");
  });

  it("still falls back to the generic map without a preset", () => {
    const generic = new RestConnector({
      name: "rest-default",
      baseUrl: base,
      authHeader: "Bearer t",
      vendorPreset: null,
    });
    expect(generic.objectTypes?.()).toContain("invoice");
  });
});

describe("a system that never answers", () => {
  it("gives up rather than hanging, and says which kind of failure it was", async () => {
    /* A server that accepts the connection and goes quiet is the normal
       behavior of a legacy system behind a flaky VPN. There was no
       timeout: the call hung indefinitely, which on a serverless
       function burns the whole execution budget and shows the user a
       blank response rather than "that system did not answer". */
    const dead = createServer(() => {});
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const port = (dead.address() as { port: number }).port;

    const c = new RestConnector({
      name: "sleepy",
      baseUrl: `http://127.0.0.1:${port}`,
      authHeader: "Bearer t",
      vendorPreset: null,
      /* The real timeout is 15s; a test must not wait that long, so the
         behavior under an aborted request is what is proved here. */
      fetchImpl: ((url: string, init: RequestInit) =>
        fetch(url, { ...init, signal: AbortSignal.timeout(150) })) as typeof fetch,
    });

    const res = await c.searchRecords("contact", "", 5);
    expect(res.ok).toBe(false);
    expect(res.code).toBe("network");
    expect(res.message).toMatch(/did not respond|network error/i);
    await new Promise<void>((r) => dead.close(() => r()));
  }, 10_000);

  it("maps every real HTTP failure to a code a caller can act on", async () => {
    const codes: Record<string, unknown> = {};
    const s = createServer((req, res) => {
      const u = req.url ?? "";
      res.setHeader("content-type", "application/json");
      for (const code of [401, 403, 404, 429, 500]) {
        if (u.includes(`/${code}`)) {
          res.statusCode = code;
          return res.end(`{"error":"${code}"}`);
        }
      }
      res.setHeader("content-type", "text/html");
      res.end("<html>maintenance</html>");
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const p = (s.address() as { port: number }).port;

    for (const path of ["401", "403", "404", "429", "500", "html"]) {
      const c = new RestConnector({
        name: "probe",
        baseUrl: `http://127.0.0.1:${p}/${path}`,
        authHeader: "Bearer t",
        vendorPreset: null,
      });
      codes[path] = (await c.searchRecords("contact", "", 5)).code;
    }
    await new Promise<void>((r) => s.close(() => r()));

    expect(codes).toEqual({
      "401": "auth_failed",
      "403": "auth_failed",
      "404": "not_found",
      "429": "rate_limited",
      "500": "remote_error",
      /* A maintenance page served with a 200 is the failure that looks
         like success. */
      html: "remote_error",
    });
  }, 15_000);
});
