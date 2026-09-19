/** @jest-environment node */
import { NextRequest } from "next/server";

const recordHarnessHit = jest.fn();
jest.mock("@/lib/harness/harness", () => ({ recordHarnessHit: (...a: unknown[]) => recordHarnessHit(...a) }));
jest.mock("@/lib/harness/sandbox", () => ({ HONEYPOT_FIELD: "contact_email_confirm" }));

import { GET, POST } from "@/app/harness/[id]/[[...slug]]/route";

const VALID = "hs_abcd1234"; // matches ^hs_[A-Za-z0-9_-]{8,64}$
const ctx = (id: string, slug?: string[]) => ({ params: Promise.resolve({ id, slug }) });
const get = (path: string) => new NextRequest(`https://apex.test${path}`, { method: "GET" });

describe("GET/POST /harness/[id]/[[...slug]] (instrumented sandbox)", () => {
  it("serves the home page (empty slug -> '/') and records the hit", async () => {
    recordHarnessHit.mockResolvedValueOnce({ ok: true, response: { status: 200, contentType: "text/html", body: "<h1>home</h1>" } });
    const res = await GET(get(`/harness/${VALID}`), ctx(VALID, undefined));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(recordHarnessHit).toHaveBeenCalledWith(expect.objectContaining({ sessionId: VALID, relPath: "/", method: "GET" }));
  });

  it("joins a multi-segment slug into a relative path (the decoy)", async () => {
    recordHarnessHit.mockResolvedValueOnce({ ok: true, response: { status: 200, contentType: "text/html", body: "records" } });
    await GET(get(`/harness/${VALID}/_ff/records`), ctx(VALID, ["_ff", "records"]));
    expect(recordHarnessHit).toHaveBeenCalledWith(expect.objectContaining({ relPath: "/_ff/records" }));
  });

  it("rejects a malformed session id at the route (404) without touching the store", async () => {
    recordHarnessHit.mockClear();
    for (const bad of ["nope", "hs_1", "hs_$(x)", "../etc"]) {
      const res = await GET(get(`/harness/${bad}`), ctx(bad, undefined));
      expect(res.status).toBe(404);
    }
    expect(recordHarnessHit).not.toHaveBeenCalled();
  });

  it("propagates a 404 for a well-formed but unknown session", async () => {
    recordHarnessHit.mockResolvedValueOnce({ ok: false, reason: "unknown", response: { status: 404, contentType: "text/html", body: "404" } });
    const res = await GET(get(`/harness/${VALID}`), ctx(VALID, undefined));
    expect(res.status).toBe(404);
  });

  it("handles a POST (form submit) path", async () => {
    recordHarnessHit.mockResolvedValueOnce({ ok: true, response: { status: 200, contentType: "text/html", body: "ok" } });
    const res = await POST(new NextRequest(`https://apex.test/harness/${VALID}/login`, { method: "POST" }), ctx(VALID, ["login"]));
    expect(res.status).toBe(200);
    expect(recordHarnessHit).toHaveBeenCalledWith(expect.objectContaining({ relPath: "/login", method: "POST" }));
  });
});
