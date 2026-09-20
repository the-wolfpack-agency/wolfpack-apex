/** @jest-environment node */
const safeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ hasDatabase: () => true, query: jest.fn(), safeQuery: (...a: unknown[]) => safeQuery(...a) }));

import { createSign, generateKeyPairSync } from "node:crypto";
import { verifyIngestSignature } from "@/lib/forcefield/ingest-signing";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
const NOW = 1_800_000_000_000;

function sign(body: string, key = privateKey, ts = NOW): string {
  return createSign("sha256").update(`${ts}.${body}`).end().sign({ key, dsaEncoding: "ieee-p1363" }).toString("base64url");
}
beforeEach(() => { safeQuery.mockReset(); safeQuery.mockResolvedValue({ rows: [{ algorithm: "es256", public_key: jwk }], fromCache: false }); });

it("verifies a correctly-signed batch from a registered source", async () => {
  const body = '{"type":"site.agent_welcomed"}';
  expect((await verifyIngestSignature({ sourceId: "mkt", timestamp: NOW, signature: sign(body), rawBody: body, nowMs: NOW })).ok).toBe(true);
});

it("rejects a forged signature (wrong key)", async () => {
  const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  const body = "{}";
  const v = await verifyIngestSignature({ sourceId: "mkt", timestamp: NOW, signature: sign(body, other), rawBody: body, nowMs: NOW });
  expect(v.ok).toBe(false);
});

it("rejects a stale signature (outside the skew window)", async () => {
  const body = "{}";
  const v = await verifyIngestSignature({ sourceId: "mkt", timestamp: NOW, signature: sign(body), rawBody: body, nowMs: NOW + 10 * 60 * 1000 });
  expect(v.ok).toBe(false);
  expect(v.reason).toMatch(/stale/i);
});

it("rejects an unregistered source", async () => {
  safeQuery.mockResolvedValue({ rows: [], fromCache: false });
  const body = "{}";
  const v = await verifyIngestSignature({ sourceId: "unknown", timestamp: NOW, signature: sign(body), rawBody: body, nowMs: NOW });
  expect(v.ok).toBe(false);
  expect(v.reason).toMatch(/unregistered/i);
});

it("rejects a body that was tampered after signing", async () => {
  const signed = sign('{"type":"good"}');
  const v = await verifyIngestSignature({ sourceId: "mkt", timestamp: NOW, signature: signed, rawBody: '{"type":"EVIL"}', nowMs: NOW });
  expect(v.ok).toBe(false);
});
